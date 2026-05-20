import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  buildObjectStorageKey,
  sanitizeFilename,
  shouldUseObjectStorage,
  uploadBufferToObjectStorage,
} from '../lib/assetStorage.js';
import { badRequest } from '../lib/httpErrors.js';
import {
  isInstitutionalRecommendationPdfEnabled,
  renderInstitutionalRecommendationPdf,
} from './recommendationReportRenderer.js';

const OUTPUT_TYPES = Object.freeze({
  archive: {
    kind: 'recommendation_archive',
    filename: 'picks.json',
    mimeType: 'application/json',
  },
  videoScript: {
    kind: 'recommendation_video_script',
    filename: 'video-script.md',
    mimeType: 'text/markdown',
  },
  pdf: {
    kind: 'recommendation_pdf',
    filename: 'recommendation-report.pdf',
    mimeType: 'application/pdf',
  },
  socialCopy: {
    kind: 'recommendation_social_copy',
    filename: 'social-copy.json',
    mimeType: 'application/json',
  },
});

export function createRecommendationOutputService({
  repository,
  serviceConfig = config,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!repository) {
    throw new Error('recommendationOutputService requires repository');
  }

  async function ensureOutputs({ batch, publicData, scriptJob, actorUid = null, timestamp = clock() } = {}) {
    const existing = normalizeOutputArtifacts(batch?.outputArtifacts);
    const context = {
      batch,
      publicData,
      scriptJob,
      actorUid,
      timestamp,
    };

    const archive = await ensureArtifact(existing.archive, context, OUTPUT_TYPES.archive, () =>
      Buffer.from(`${JSON.stringify(buildPicksArchive(publicData, timestamp), null, 2)}\n`, 'utf8'),
    );
    const videoScript = await ensureArtifact(existing.videoScript, context, OUTPUT_TYPES.videoScript, () =>
      Buffer.from(buildVideoScript(publicData, timestamp), 'utf8'),
    );
    const pdf = await ensureArtifact(existing.pdf, context, OUTPUT_TYPES.pdf, () =>
      buildRecommendationPdfBuffer({ publicData, generatedAt: timestamp, serviceConfig }),
    );
    const socialCopy = await ensureArtifact(existing.socialCopy, context, OUTPUT_TYPES.socialCopy, () =>
      Buffer.from(`${JSON.stringify(buildSocialCopy(publicData, timestamp), null, 2)}\n`, 'utf8'),
    );

    return {
      archive: artifactSummary(archive),
      videoScript: artifactSummary(videoScript),
      pdf: artifactSummary(pdf),
      socialCopy: artifactSummary(socialCopy),
      generatedAt: timestamp,
    };
  }

  async function ensureArtifact(existingSummary, context, type, buildBuffer) {
    const reusable = await getReusableArtifact(existingSummary);
    if (reusable) {
      return reusable;
    }

    const filename = outputFilename(type.filename, context.publicData);
    const buffer = await buildBuffer();
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    return storeBufferArtifact({
      jobId: context.scriptJob.id,
      batchId: context.publicData.recommendationBatchId,
      kind: type.kind,
      filename,
      mimeType: type.mimeType,
      buffer,
      checksum,
      metadata: {
        recommendationBatchId: context.publicData.recommendationBatchId,
        recommendationId: context.publicData.recommendationId ?? context.publicData.recommendations?.[0]?.id ?? null,
        recommendationSymbol: context.publicData.recommendationSymbol ?? context.publicData.recommendations?.[0]?.symbol ?? null,
        tradeDate: context.publicData.tradeDate,
        outputType: type.kind,
        generatedAt: context.timestamp,
        generatedBy: context.actorUid,
      },
    });
  }

  async function getReusableArtifact(summary) {
    const artifactId = summary?.artifactId ?? summary?.id;
    if (!artifactId) {
      return null;
    }
    const artifact = await repository.getArtifact(artifactId);
    if (!artifact) {
      return null;
    }
    if (artifact.storageProvider !== 'local-disk') {
      return artifact;
    }

    const rootDir = path.resolve(process.cwd(), serviceConfig.localDataDir);
    const filePath = path.resolve(rootDir, artifact.storageKey);
    if (!isPathInside(rootDir, filePath)) {
      return null;
    }
    try {
      await fsp.stat(filePath);
      return artifact;
    } catch {
      return null;
    }
  }

  async function storeBufferArtifact({ jobId, batchId, kind, filename, mimeType, buffer, checksum, metadata }) {
    if (shouldUseObjectStorage()) {
      const stored = await uploadBufferToObjectStorage({
        storageKey: buildObjectStorageKey({
          jobId,
          kind,
          filename,
        }),
        buffer,
        mimeType,
      });
      return repository.createArtifact({
        jobId,
        kind,
        storageProvider: stored.storageProvider,
        storageKey: stored.storageKey,
        mimeType,
        sizeBytes: stored.sizeBytes,
        checksum,
        metadata: {
          ...metadata,
          filename,
          ...stored.metadata,
        },
      });
    }

    const rootDir = path.resolve(process.cwd(), serviceConfig.localDataDir);
    const storageKey = path.join(
      'recommendation-artifacts',
      safePathSegment(batchId),
      safePathSegment(jobId),
      safePathSegment(kind),
      filename,
    );
    const filePath = path.resolve(rootDir, storageKey);
    if (!isPathInside(rootDir, filePath)) {
      throw badRequest('Invalid recommendation output path');
    }

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buffer);
    return repository.createArtifact({
      jobId,
      kind,
      storageProvider: 'local-disk',
      storageKey,
      mimeType,
      sizeBytes: buffer.length,
      checksum,
      metadata: {
        ...metadata,
        filename,
        localPath: filePath,
      },
    });
  }

  return {
    ensureOutputs,
  };
}

async function buildRecommendationPdfBuffer({ publicData, generatedAt, serviceConfig }) {
  const legacyBuffer = () => buildPdfBuffer(buildPdfDocument(publicData, generatedAt));
  if (!isInstitutionalRecommendationPdfEnabled(serviceConfig)) {
    return legacyBuffer();
  }

  try {
    return await renderInstitutionalRecommendationPdf({ publicData, generatedAt, serviceConfig });
  } catch (error) {
    if (serviceConfig.pdf?.fallbackToLegacy === false) {
      throw error;
    }
    console.warn(`Falling back to legacy recommendation PDF renderer: ${error.message}`);
    return legacyBuffer();
  }
}

function buildPicksArchive(publicData, generatedAt) {
  return {
    recommendationBatchId: publicData.recommendationBatchId,
    tradeDate: publicData.tradeDate,
    weekId: publicData.weekId,
    title: publicData.title,
    theme: publicData.theme,
    generatedAt,
    pickCount: publicData.recommendations.length,
    picks: publicData.recommendations.map((item) => ({
      id: item.id,
      tileId: item.tileId,
      symbol: item.symbol,
      strategy: item.strategy,
      direction: item.direction,
      price: item.price,
      expiry: item.expiry,
      legs: item.legs,
      rewardRisk: item.rewardRisk,
      oddsOfProfit: item.oddsOfProfit,
      maxProfit: item.maxProfit,
      thesis: item.thesis,
      riskNotes: item.riskNotes,
      entry: item.entry,
      exit: item.exit,
      ivContext: item.ivContext,
      sentiment: item.sentiment,
      lifecycle: item.lifecycle,
    })),
  };
}

function buildVideoScript(publicData, generatedAt) {
  const lines = [
    `# NewLeaf Daily Picks - ${publicData.tradeDate}`,
    '',
    `Generated: ${generatedAt}`,
    `Theme: ${publicData.theme || 'Defined-risk options ideas'}`,
    '',
    'These ideas are educational, model-estimated, and not guaranteed. Use defined risk and your own suitability checks.',
    '',
    ...publicData.recommendations.flatMap((item, index) => [
      `## Pick ${index + 1}: ${item.symbol} - ${item.strategy}`,
      '',
      `Direction: ${item.direction}`,
      item.expiry ? `Expiry: ${item.expiry}` : '',
      item.price != null ? `Reference price: ${formatMoney(item.price)}` : '',
      item.oddsOfProfit != null ? `Model-estimated probability: ${item.oddsOfProfit}%` : '',
      item.rewardRisk != null ? `Reward/risk: ${item.rewardRisk}` : '',
      item.maxProfit != null ? `Max profit: ${formatMoney(item.maxProfit)}` : '',
      '',
      `Thesis: ${item.thesis}`,
      item.riskNotes ? `Risk notes: ${item.riskNotes}` : '',
      item.entry ? `Entry: ${item.entry}` : '',
      item.exit ? `Exit: ${item.exit}` : '',
      '',
    ]),
    'Close: Review the full card before acting, size positions carefully, and treat every trade as a risk-managed plan.',
    '',
  ];
  return `${lines.filter((line) => line !== null && line !== undefined).join('\n')}`;
}

function buildSocialCopy(publicData, generatedAt) {
  return {
    recommendationBatchId: publicData.recommendationBatchId,
    tradeDate: publicData.tradeDate,
    generatedAt,
    batch: {
      linkedin: [
        `${publicData.title}: ${publicData.recommendations.length} model-estimated options ideas for ${publicData.tradeDate}.`,
        publicData.theme ? `Theme: ${publicData.theme}.` : '',
        'Each card is framed around defined risk, thesis, invalidation, and position management. These are educational drafts, not guaranteed outcomes.',
        'Review the full picks at newleafsystem.com/picks.',
      ].filter(Boolean).join('\n\n'),
      xThread: [
        `NewLeaf Daily Picks for ${publicData.tradeDate}: ${publicData.recommendations.length} defined-risk setups.`,
        'Educational, model-estimated, and not guaranteed. Know max loss before entering any trade.',
        'Full cards: newleafsystem.com/picks',
      ],
      instagram: [
        `${publicData.title}: ${publicData.recommendations.length} defined-risk options ideas.`,
        publicData.theme || 'Review thesis, risk, entry, and exit before acting.',
        '#options #trading #riskmanagement #definedrisk #newleafsystem',
      ].join('\n\n'),
    },
    picks: publicData.recommendations.map((item) => ({
      id: item.id,
      symbol: item.symbol,
      linkedin: buildLinkedInPost(item),
      xThread: buildXThread(item),
      instagram: buildInstagramCaption(item),
    })),
  };
}

function buildLinkedInPost(item) {
  return [
    `${item.symbol} - ${item.strategy}`,
    '',
    `${item.thesis}`,
    '',
    item.oddsOfProfit != null ? `Model-estimated probability: ${item.oddsOfProfit}%.` : '',
    item.rewardRisk != null ? `Reward/risk: ${item.rewardRisk}.` : '',
    item.riskNotes ? `Risk note: ${item.riskNotes}` : '',
    '',
    'Educational only. Outcomes are not guaranteed; review suitability, liquidity, and defined risk before acting.',
  ].filter(Boolean).join('\n');
}

function buildXThread(item) {
  return [
    `$${item.symbol} ${item.strategy}. ${truncateSentence(item.thesis, 170)}`,
    item.oddsOfProfit != null
      ? `$${item.symbol}: ${item.oddsOfProfit}% model-estimated probability, ${item.direction.toLowerCase()} setup. Not guaranteed.`
      : `$${item.symbol}: ${item.direction.toLowerCase()} defined-risk setup. Not guaranteed.`,
    item.riskNotes
      ? `Risk: ${truncateSentence(item.riskNotes, 210)}`
      : 'Risk: size carefully, know max loss, and use your own suitability checks.',
  ];
}

function buildInstagramCaption(item) {
  return [
    `${item.symbol} ${item.strategy}`,
    truncateSentence(item.thesis, 260),
    item.riskNotes ? `Risk: ${truncateSentence(item.riskNotes, 180)}` : '',
    '#options #definedrisk #tradingplan #riskmanagement #newleafsystem',
  ].filter(Boolean).join('\n\n');
}

const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 42;
const PDF_BOTTOM_MARGIN = 54;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - (PDF_MARGIN * 2);
const PDF_COLORS = Object.freeze({
  forest: [0.035, 0.18, 0.145],
  green: [0.06, 0.36, 0.27],
  gold: [0.73, 0.57, 0.25],
  cream: [0.98, 0.965, 0.91],
  softGreen: [0.93, 0.965, 0.94],
  border: [0.78, 0.72, 0.58],
  ink: [0.08, 0.12, 0.1],
  muted: [0.34, 0.39, 0.36],
  white: [1, 1, 1],
});

function buildPdfDocument(publicData, generatedAt) {
  const pages = [];
  let page = null;
  let y = PDF_PAGE_HEIGHT - PDF_MARGIN;

  const add = (operation) => {
    page.push(operation);
  };
  const addText = (text, x, baseline, {
    size = 10,
    font = 'regular',
    color = PDF_COLORS.ink,
  } = {}) => {
    add({ type: 'text', text, x, y: baseline, size, font, color });
  };
  const addRect = (x, top, width, height, {
    fill = null,
    stroke = null,
    lineWidth = 1,
  } = {}) => {
    add({ type: 'rect', x, y: top - height, width, height, fill, stroke, lineWidth });
  };
  const addLine = (x1, y1, x2, y2, {
    color = PDF_COLORS.border,
    lineWidth = 1,
  } = {}) => {
    add({ type: 'line', x1, y1, x2, y2, color, lineWidth });
  };
  const addWrappedText = (text, x, baseline, width, {
    size = 9,
    font = 'regular',
    color = PDF_COLORS.ink,
    lineHeight = size + 4,
  } = {}) => {
    const lines = wrapPdfText(text, width, size);
    let cursor = baseline;
    for (const line of lines) {
      addText(line, x, cursor, { size, font, color });
      cursor -= lineHeight;
    }
    return Math.max(lineHeight, lines.length * lineHeight);
  };
  const ensureSpace = (height) => {
    if (y - height >= PDF_BOTTOM_MARGIN) {
      return;
    }
    startPage(true);
  };
  const startPage = (continuation = false) => {
    page = [];
    pages.push(page);
    y = PDF_PAGE_HEIGHT - PDF_MARGIN;
    if (continuation) {
      addText('NewLeaf System', PDF_MARGIN, y, { size: 11, font: 'bold', color: PDF_COLORS.forest });
      addText('Recommendation Report', PDF_PAGE_WIDTH - 176, y, {
        size: 9,
        font: 'bold',
        color: PDF_COLORS.muted,
      });
      addLine(PDF_MARGIN, y - 12, PDF_PAGE_WIDTH - PDF_MARGIN, y - 12, {
        color: PDF_COLORS.gold,
        lineWidth: 1.2,
      });
      y -= 34;
    }
  };

  startPage(false);
  addReportHeader({ publicData, generatedAt, addRect, addText });
  y = PDF_PAGE_HEIGHT - 132;

  addSummaryPanel({ publicData, generatedAt, addRect, addText });
  y -= 88;

  ensureSpace(54);
  addRect(PDF_MARGIN, y, PDF_CONTENT_WIDTH, 44, {
    fill: PDF_COLORS.softGreen,
    stroke: PDF_COLORS.border,
  });
  addText('Risk Framing', PDF_MARGIN + 16, y - 16, { size: 10, font: 'bold', color: PDF_COLORS.forest });
  addWrappedText(
    'Educational, model-estimated, and not guaranteed. Use defined risk, liquidity checks, and your own suitability review before acting.',
    PDF_MARGIN + 16,
    y - 31,
    PDF_CONTENT_WIDTH - 32,
    { size: 8.5, color: PDF_COLORS.muted, lineHeight: 11 },
  );
  y -= 62;

  publicData.recommendations.forEach((item, index) => {
    addPickCard({
      item,
      index,
      ensureSpace,
      addRect,
      addLine,
      addText,
      addWrappedText,
      getY: () => y,
      setY: (value) => {
        y = value;
      },
    });
  });

  pages.forEach((operations, index) => {
    operations.push({
      type: 'line',
      x1: PDF_MARGIN,
      y1: 36,
      x2: PDF_PAGE_WIDTH - PDF_MARGIN,
      y2: 36,
      color: PDF_COLORS.border,
      lineWidth: 0.6,
    });
    operations.push({
      type: 'text',
      text: 'Educational only. Outcomes are not guaranteed.',
      x: PDF_MARGIN,
      y: 22,
      size: 7,
      font: 'regular',
      color: PDF_COLORS.muted,
    });
    operations.push({
      type: 'text',
      text: `Page ${index + 1} of ${pages.length}`,
      x: PDF_PAGE_WIDTH - 92,
      y: 22,
      size: 7,
      font: 'regular',
      color: PDF_COLORS.muted,
    });
  });

  return pages;
}

function addReportHeader({ publicData, generatedAt, addRect, addText }) {
  addRect(0, PDF_PAGE_HEIGHT, PDF_PAGE_WIDTH, 104, { fill: PDF_COLORS.forest });
  addRect(0, PDF_PAGE_HEIGHT - 104, PDF_PAGE_WIDTH, 5, { fill: PDF_COLORS.gold });
  addText('NewLeaf System', PDF_MARGIN, PDF_PAGE_HEIGHT - 44, {
    size: 17,
    font: 'bold',
    color: PDF_COLORS.white,
  });
  addText(publicData.title || 'Daily Picks', PDF_MARGIN, PDF_PAGE_HEIGHT - 72, {
    size: 22,
    font: 'bold',
    color: PDF_COLORS.gold,
  });
  addText(`Trade date: ${publicData.tradeDate} | Generated: ${generatedAt}`, PDF_MARGIN, PDF_PAGE_HEIGHT - 92, {
    size: 8.5,
    color: PDF_COLORS.white,
  });
  addText('Defined-risk options ideas', PDF_PAGE_WIDTH - 184, PDF_PAGE_HEIGHT - 52, {
    size: 10,
    font: 'bold',
    color: PDF_COLORS.white,
  });
  addText('Admin review report', PDF_PAGE_WIDTH - 184, PDF_PAGE_HEIGHT - 70, {
    size: 8.5,
    color: PDF_COLORS.gold,
  });
}

function addSummaryPanel({ publicData, generatedAt, addRect, addText }) {
  const top = PDF_PAGE_HEIGHT - 132;
  addRect(PDF_MARGIN, top, PDF_CONTENT_WIDTH, 68, {
    fill: PDF_COLORS.cream,
    stroke: PDF_COLORS.border,
    lineWidth: 0.9,
  });
  addText('Report Summary', PDF_MARGIN + 16, top - 18, {
    size: 11,
    font: 'bold',
    color: PDF_COLORS.forest,
  });
  addText(`Picks: ${publicData.recommendations.length}`, PDF_MARGIN + 16, top - 40, {
    size: 9,
    font: 'bold',
    color: PDF_COLORS.ink,
  });
  addText(`Week: ${publicData.weekId ?? publicData.tradeDate}`, PDF_MARGIN + 120, top - 40, {
    size: 9,
    color: PDF_COLORS.ink,
  });
  addText(`Generated: ${generatedAt}`, PDF_MARGIN + 266, top - 40, {
    size: 9,
    color: PDF_COLORS.ink,
  });
  if (publicData.theme) {
    addText(`Theme: ${truncateSentence(publicData.theme, 90)}`, PDF_MARGIN + 16, top - 56, {
      size: 8.5,
      color: PDF_COLORS.muted,
    });
  }
}

function addPickCard({
  item,
  index,
  ensureSpace,
  addRect,
  addLine,
  addText,
  addWrappedText,
  getY,
  setY,
}) {
  const textWidth = PDF_CONTENT_WIDTH - 32;
  const thesisHeight = measurePdfTextHeight(item.thesis, textWidth, 9, 12);
  const riskHeight = measurePdfTextHeight(item.riskNotes, textWidth, 8.5, 11);
  const entryExitText = [item.entry ? `Entry: ${item.entry}` : '', item.exit ? `Exit: ${item.exit}` : '']
    .filter(Boolean)
    .join(' ');
  const entryExitHeight = entryExitText ? measurePdfTextHeight(entryExitText, textWidth, 8.5, 11) : 0;
  const legSummary = buildLegSummary(item);
  const legHeight = legSummary ? measurePdfTextHeight(legSummary, textWidth, 8, 10) : 0;
  const cardHeight =
    154 +
    thesisHeight +
    (item.riskNotes ? 18 + riskHeight : 0) +
    (entryExitText ? 18 + entryExitHeight : 0) +
    (legSummary ? 17 + legHeight : 0);

  ensureSpace(cardHeight + 18);

  const top = getY();
  const bottom = top - cardHeight;
  addRect(PDF_MARGIN, top, PDF_CONTENT_WIDTH, cardHeight, {
    fill: [1, 1, 1],
    stroke: PDF_COLORS.border,
    lineWidth: 0.8,
  });
  addRect(PDF_MARGIN, top, 5, cardHeight, { fill: PDF_COLORS.green });

  addText(`Pick ${index + 1}`, PDF_MARGIN + 16, top - 19, {
    size: 8,
    font: 'bold',
    color: PDF_COLORS.gold,
  });
  addText(`${item.symbol} - ${item.strategy}`, PDF_MARGIN + 16, top - 38, {
    size: 14,
    font: 'bold',
    color: PDF_COLORS.forest,
  });
  addText(item.direction || 'REVIEW', PDF_PAGE_WIDTH - 112, top - 28, {
    size: 9,
    font: 'bold',
    color: PDF_COLORS.green,
  });

  const metricTop = top - 58;
  addMetricRow({
    item,
    metricTop,
    addText,
  });
  addLine(PDF_MARGIN + 16, metricTop - 46, PDF_PAGE_WIDTH - PDF_MARGIN - 16, metricTop - 46, {
    color: PDF_COLORS.border,
    lineWidth: 0.5,
  });

  let cursor = metricTop - 66;
  addText('Thesis', PDF_MARGIN + 16, cursor, {
    size: 8.5,
    font: 'bold',
    color: PDF_COLORS.forest,
  });
  cursor -= 14;
  cursor -= addWrappedText(item.thesis, PDF_MARGIN + 16, cursor, textWidth, {
    size: 9,
    color: PDF_COLORS.ink,
    lineHeight: 12,
  });

  if (item.riskNotes) {
    cursor -= 5;
    addText('Risk Notes', PDF_MARGIN + 16, cursor, {
      size: 8.5,
      font: 'bold',
      color: PDF_COLORS.forest,
    });
    cursor -= 13;
    cursor -= addWrappedText(item.riskNotes, PDF_MARGIN + 16, cursor, textWidth, {
      size: 8.5,
      color: PDF_COLORS.muted,
      lineHeight: 11,
    });
  }

  if (entryExitText) {
    cursor -= 5;
    addText('Plan', PDF_MARGIN + 16, cursor, {
      size: 8.5,
      font: 'bold',
      color: PDF_COLORS.forest,
    });
    cursor -= 13;
    cursor -= addWrappedText(entryExitText, PDF_MARGIN + 16, cursor, textWidth, {
      size: 8.5,
      color: PDF_COLORS.muted,
      lineHeight: 11,
    });
  }

  if (legSummary) {
    cursor -= 5;
    addText('Option Legs', PDF_MARGIN + 16, cursor, {
      size: 8.5,
      font: 'bold',
      color: PDF_COLORS.forest,
    });
    cursor -= 12;
    addWrappedText(legSummary, PDF_MARGIN + 16, cursor, textWidth, {
      size: 8,
      color: PDF_COLORS.muted,
      lineHeight: 10,
    });
  }

  setY(bottom - 18);
}

function addMetricRow({ item, metricTop, addText }) {
  const metrics = [
    ['Reference Price', item.price != null ? formatMoney(item.price) : 'Market data pending'],
    ['Expiry', item.expiry || 'Review'],
    ['Max Profit', item.maxProfit != null ? formatMoney(item.maxProfit) : 'Model pending'],
    ['Max Loss', item.maxLoss != null ? formatMoney(item.maxLoss) : 'Model pending'],
    ['Reward/Risk', item.rewardRisk != null ? String(item.rewardRisk) : 'Model pending'],
    ['Model PoP', item.oddsOfProfit != null ? `${item.oddsOfProfit}%` : 'Model pending'],
  ];
  const colWidth = PDF_CONTENT_WIDTH / 3;
  metrics.forEach(([label, value], index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const x = PDF_MARGIN + 16 + (col * colWidth);
    const baseline = metricTop - (row * 22);
    addText(label, x, baseline, {
      size: 7.2,
      font: 'bold',
      color: PDF_COLORS.muted,
    });
    addText(value, x, baseline - 11, {
      size: 9,
      font: 'bold',
      color: PDF_COLORS.ink,
    });
  });
}

function buildLegSummary(item) {
  if (!Array.isArray(item.legs) || item.legs.length === 0) {
    return '';
  }
  return item.legs
    .slice(0, 6)
    .map((leg) => [
      leg.action,
      leg.quantity ? `${leg.quantity}x` : '',
      leg.type,
      leg.strike != null ? `${leg.strike}` : '',
      leg.premium != null ? `@ ${formatMoney(leg.premium)}` : '',
    ].filter(Boolean).join(' '))
    .join('; ');
}

function measurePdfTextHeight(text, width, size, lineHeight) {
  const lines = wrapPdfText(text, width, size);
  return Math.max(lineHeight, lines.length * lineHeight);
}

function buildPdfBuffer(pages) {
  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject('');
  const fontObjectId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontObjectId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageObjectIds = [];

  for (const page of pages) {
    const stream = pageToPdfStream(page);
    const contentObjectId = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageObjectId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontObjectId} 0 R /F2 ${boldFontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    pageObjectIds.push(pageObjectId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function pageToPdfStream(page) {
  return page
    .map((operation) => {
      if (operation.type === 'rect') {
        return rectToPdf(operation);
      }
      if (operation.type === 'line') {
        return lineToPdf(operation);
      }
      const font = operation.font === 'bold' ? 'F2' : 'F1';
      return `BT /${font} ${operation.size} Tf ${rgb(operation.color)} rg ${operation.x} ${operation.y} Td (${escapePdfText(operation.text)}) Tj ET`;
    })
    .join('\n');
}

function rectToPdf(operation) {
  const commands = [];
  if (operation.fill) {
    commands.push(`q ${rgb(operation.fill)} rg ${operation.x} ${operation.y} ${operation.width} ${operation.height} re f Q`);
  }
  if (operation.stroke) {
    commands.push(
      `q ${rgb(operation.stroke)} RG ${operation.lineWidth ?? 1} w ${operation.x} ${operation.y} ${operation.width} ${operation.height} re S Q`,
    );
  }
  return commands.join('\n');
}

function lineToPdf(operation) {
  return `q ${rgb(operation.color)} RG ${operation.lineWidth ?? 1} w ${operation.x1} ${operation.y1} m ${operation.x2} ${operation.y2} l S Q`;
}

function rgb(color = PDF_COLORS.ink) {
  return color.map((value) => Number(value).toFixed(3)).join(' ');
}

function wrapPdfText(text, width, size) {
  const normalized = normalizePdfText(text);
  if (!normalized) return [''];
  const maxChars = Math.max(12, Math.floor(width / (size * 0.52)));
  const words = normalized.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapePdfText(value) {
  return normalizePdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function normalizePdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function artifactSummary(artifact) {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes ?? null,
    checksum: artifact.checksum ?? null,
    storageProvider: artifact.storageProvider,
    storageKey: artifact.storageKey,
    filename: artifact.metadata?.filename ?? null,
    createdAt: artifact.createdAt ?? null,
    updatedAt: artifact.updatedAt ?? null,
  };
}

function normalizeOutputArtifacts(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function outputFilename(baseFilename, publicData) {
  const date = String(publicData.tradeDate ?? 'daily-picks').replace(/[^0-9-]/g, '');
  const pick = Array.isArray(publicData.recommendations) && publicData.recommendations.length === 1
    ? publicData.recommendations[0]
    : null;
  const scope = [
    date || 'daily-picks',
    pick?.symbol ? safePathSegment(pick.symbol).toLowerCase() : '',
  ].filter(Boolean).join('-');
  const name = baseFilename === 'recommendation-report.pdf'
    ? `${scope}-recommendation-report.pdf`
    : `${scope}-${baseFilename}`;
  return sanitizeFilename(name);
}

function formatMoney(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '';
  return `$${numberValue.toFixed(2)}`;
}

function truncateSentence(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function safePathSegment(value) {
  return String(value ?? 'item').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'item';
}

function isPathInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
