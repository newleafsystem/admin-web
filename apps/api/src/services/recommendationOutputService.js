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
      buildPdfBuffer(buildPdfLines(publicData, timestamp)),
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

function buildPdfLines(publicData, generatedAt) {
  const lines = [
    { text: 'NewLeaf System', size: 18 },
    { text: publicData.title || 'Daily Picks', size: 16 },
    { text: `Trade date: ${publicData.tradeDate}`, size: 10 },
    { text: `Generated: ${generatedAt}`, size: 10 },
    { text: publicData.theme ? `Theme: ${publicData.theme}` : '', size: 10 },
    { text: '', size: 10 },
    {
      text: 'Educational, model-estimated, and not guaranteed. Use defined risk and your own suitability checks.',
      size: 10,
    },
    { text: '', size: 10 },
  ];

  publicData.recommendations.forEach((item, index) => {
    lines.push(
      { text: `${index + 1}. ${item.symbol} - ${item.strategy}`, size: 14 },
      { text: `Direction: ${item.direction}${item.expiry ? ` | Expiry: ${item.expiry}` : ''}`, size: 10 },
      { text: metricLine(item), size: 10 },
      { text: `Thesis: ${item.thesis}`, size: 10 },
      { text: item.riskNotes ? `Risk notes: ${item.riskNotes}` : '', size: 10 },
      { text: item.entry ? `Entry: ${item.entry}` : '', size: 10 },
      { text: item.exit ? `Exit: ${item.exit}` : '', size: 10 },
      { text: '', size: 10 },
    );
  });

  return lines.filter((line) => line.text !== null && line.text !== undefined);
}

function metricLine(item) {
  return [
    item.price != null ? `Reference: ${formatMoney(item.price)}` : '',
    item.maxProfit != null ? `Max profit: ${formatMoney(item.maxProfit)}` : '',
    item.rewardRisk != null ? `Reward/risk: ${item.rewardRisk}` : '',
    item.oddsOfProfit != null ? `PoP: ${item.oddsOfProfit}%` : '',
  ].filter(Boolean).join(' | ');
}

function buildPdfBuffer(lines) {
  const pages = paginatePdfLines(lines);
  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject('');
  const fontObjectId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageObjectIds = [];

  for (const page of pages) {
    const stream = pageToPdfStream(page, fontObjectId);
    const contentObjectId = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageObjectId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
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

function paginatePdfLines(lines) {
  const pages = [[]];
  let y = 744;

  for (const line of lines) {
    const wrapped = wrapText(line.text, line.size >= 14 ? 58 : 88);
    for (const text of wrapped.length > 0 ? wrapped : ['']) {
      const height = line.size >= 14 ? 20 : 14;
      if (y < 54) {
        pages.push([]);
        y = 744;
      }
      pages[pages.length - 1].push({
        text,
        x: 48,
        y,
        size: line.size,
      });
      y -= height;
    }
  }

  return pages;
}

function pageToPdfStream(page) {
  return page
    .map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${escapePdfText(line.text)}) Tj ET`)
    .join('\n');
}

function wrapText(text, maxChars) {
  const normalized = normalizePdfText(text);
  if (!normalized) return [''];
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
  const name = baseFilename === 'recommendation-report.pdf'
    ? `${date || 'daily-picks'}-recommendation-report.pdf`
    : baseFilename;
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
