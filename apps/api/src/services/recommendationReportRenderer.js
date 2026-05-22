import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = path.join(MODULE_DIR, 'renderRecommendationReport.py');
const REPORT_ASSETS_DIR = path.join(MODULE_DIR, '..', 'report-assets');
const REPORT_TEMPLATE = path.join(REPORT_ASSETS_DIR, 'templates', 'report-v3.html');
const REPORT_LOGO = path.join(REPORT_ASSETS_DIR, 'assets', 'logos', 'newleaf-logo.png');
const DEFAULT_RENDER_TIMEOUT_MS = 90000;

export function isInstitutionalRecommendationPdfEnabled(serviceConfig = {}) {
  const renderer = String(serviceConfig.pdf?.recommendationRenderer ?? 'institutional').trim().toLowerCase();
  return !['legacy', 'legacy-custom', 'custom', 'manual', 'off', 'false'].includes(renderer);
}

export async function renderInstitutionalRecommendationPdf({
  publicData,
  generatedAt,
  serviceConfig = {},
} = {}) {
  const data = buildInstitutionalRecommendationReportData(publicData, generatedAt);
  const renderer = institutionalRendererName(serviceConfig);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'newleaf-recommendation-report-'));
  const inputPath = path.join(tempDir, 'report-data.json');
  const outputPath = path.join(tempDir, 'report.pdf');

  try {
    await fsp.writeFile(inputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (renderer === 'chrome') {
      await renderWithChrome({ data, outputPath, tempDir, serviceConfig });
    } else {
      try {
        await runWeasyprintRenderer({
          inputPath,
          outputPath,
          serviceConfig,
        });
      } catch (error) {
        if (renderer === 'weasyprint') {
          throw error;
        }
        await renderWithChrome({ data, outputPath, tempDir, serviceConfig });
      }
    }
    const buffer = await fsp.readFile(outputPath);
    if (buffer.length < 8 || buffer.subarray(0, 4).toString('utf8') !== '%PDF') {
      throw new Error('Institutional PDF renderer did not produce a valid PDF');
    }
    return buffer;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function buildInstitutionalRecommendationReportData(publicData = {}, generatedAt = new Date().toISOString()) {
  const item = Array.isArray(publicData.recommendations) ? publicData.recommendations[0] ?? {} : {};
  const lifecycle = plainObject(item.lifecycle);
  const marketData = plainObject(lifecycle.marketData);
  const gammaContext = normalizeGammaContext(lifecycle.gammaContext);
  const indicators = plainObject(lifecycle.technicalIndicators);
  const advisor = plainObject(lifecycle.strategyAdvisor);
  const calculation = plainObject(lifecycle.calculation);
  const greeks = {
    ...plainObject(calculation.greeks),
    ...plainObject(item.greeks),
  };
  const breakevens = {
    ...plainObject(calculation.breakevens),
    ...plainObject(item.breakevens),
  };
  const legs = normalizeLegs(item.legs);
  const roles = assignLegRoles(legs);

  const symbol = textValue(item.symbol ?? publicData.recommendationSymbol ?? 'PICK');
  const strategyName = textValue(item.strategy ?? 'Defined-Risk Options Spread');
  const companyName = textValue(item.companyName ?? lifecycle.company?.name ?? lifecycle.companyName ?? symbol);
  const currentPrice = firstFiniteNumber(item.price, item.underlyingPrice, marketData.spotPrice, marketData.price);
  const priceChange = firstFiniteNumber(marketData.priceChange, marketData.change, item.priceChange);
  const priceChangePercent = firstFiniteNumber(
    marketData.priceChangePercent,
    marketData.changePercent,
    marketData.changePct,
    item.priceChangePercent,
  );
  const expiry = textValue(item.expiry ?? calculation.expiry ?? '');
  const dte = firstFiniteNumber(item.dte, calculation.dte) ?? daysToExpiry(expiry, publicData.tradeDate ?? generatedAt);
  const maxProfit = firstFiniteNumber(item.maxProfit, calculation.maxProfit);
  const maxLoss = firstFiniteNumber(item.maxLoss, calculation.maxLoss);
  const netCredit = firstFiniteNumber(item.netCredit, calculation.netCredit);
  const netDebit = firstFiniteNumber(item.netDebit, calculation.netDebit);
  const oddsOfProfit = firstFiniteNumber(item.oddsOfProfit, item.winRate, calculation.oddsOfProfit);
  const rewardRisk = item.rewardRisk ?? calculation.rewardRisk;
  const lowBreakeven = firstFiniteNumber(breakevens.lower, breakevens.low, breakevens.values?.[0]);
  const highBreakeven = firstFiniteNumber(
    breakevens.upper,
    breakevens.high,
    Array.isArray(breakevens.values) ? breakevens.values[breakevens.values.length - 1] : null,
  );
  const currentIv = firstFiniteNumber(
    item.ivContext?.currentIV,
    item.ivContext?.currentIv,
    item.ivContext?.iv,
    indicators.currentIV,
    indicators.currentIv,
    average(legs.map((leg) => leg.iv)),
  );
  const tradeScore = clamp(
    Math.round(firstFiniteNumber(advisor.score, item.confidenceScore, item.score) ?? scoreFromRecommendation(item)),
    0,
    100,
  );
  const putWall = firstFiniteNumber(
    gammaContext.put_wall,
    gammaContext.putWall,
    gammaContext.putWallStrike,
    gammaContext.support,
  );
  const callWall = firstFiniteNumber(
    gammaContext.call_wall,
    gammaContext.callWall,
    gammaContext.callWallStrike,
    gammaContext.resistance,
  );

  const thesisSentences = splitInsightPoints(
    item.thesis,
    advisor.rationale,
    advisor.marketRead,
    publicData.theme,
  );
  const rationalePoints = buildRationalePoints({
    item,
    advisor,
    roles,
    putWall,
    callWall,
    maxLoss,
    oddsOfProfit,
  });
  const marketEnvironment = firstText(
    advisor.marketRead,
    lifecycle.marketEnvironment,
    item.marketEnvironment,
    item.thesis,
    `${symbol} is framed as a ${String(strategyName).toLowerCase()} candidate with defined risk and live-market validation required before entry.`,
  );

  const data = {
    HAS_MACRO: '1',
    HAS_COMPANY: '1',
    HAS_ANALYST: analystDataAvailable(item, lifecycle) ? '1' : '',
    SYMBOL: safeHtml(symbol),
    COMPANY_NAME: safeHtml(companyName),
    STRATEGY_NAME: safeHtml(strategyName),
    REPORT_DATE: safeHtml(formatReportDate(publicData.tradeDate ?? generatedAt, generatedAt)),
    REPORT_TIME: safeHtml(formatReportTime(generatedAt)),
    EXPIRATION_DATE: safeHtml(formatLongDate(expiry) || expiry || 'Review required'),
    DAYS_TO_EXPIRY: safeHtml(dte ?? 'N/A'),
    CURRENT_PRICE: safeHtml(formatMoney(currentPrice, { digits: 2 }) || 'Market data pending'),
    PRICE_CHANGE: safeHtml(formatPriceChange(priceChange, priceChangePercent)),
    MAX_PROFIT: safeHtml(formatMoney(maxProfit, { compact: true }) || 'Model pending'),
    MAX_PROFIT_DESC: safeHtml(maxProfit == null ? 'awaiting priced legs' : netCredit != null ? `per contract (${formatMoney(netCredit, { digits: 2 })} credit)` : 'per contract'),
    MAX_LOSS: safeHtml(formatMoney(maxLoss, { compact: true }) || 'Model pending'),
    MAX_LOSS_DESC: safeHtml(maxLoss == null ? 'requires admin review' : 'per contract (defined risk)'),
    WIN_RATE: safeHtml(oddsOfProfit == null ? 'N/A' : Math.round(oddsOfProfit)),
    WIN_RATE_DESC: safeHtml(oddsOfProfit == null ? 'model pending' : 'model-estimated probability'),
    RISK_REWARD: safeHtml(formatRiskReward(rewardRisk) || 'Model pending'),
    RISK_REWARD_DESC: safeHtml('premium collected vs. max risk'),
    BREAKEVEN_LOW: safeHtml(formatStrike(lowBreakeven) || 'N/A'),
    BREAKEVEN_HIGH: safeHtml(formatStrike(highBreakeven) || 'N/A'),
    BREAKEVEN_RANGE: safeHtml(formatBreakevenRange(lowBreakeven, highBreakeven)),
    BREAKEVEN_RANGE_DESC: safeHtml('profit zone at expiration'),
    TRADE_SCORE: safeHtml(tradeScore),
    CONFIDENCE_LEVEL: safeHtml(confidenceLabel(tradeScore)),
    CONFIDENCE_THRESHOLD_LABEL: safeHtml(confidenceThresholdLabel(tradeScore)),
    TRADE_CONFIG: safeHtml(buildTradeConfig({ symbol, strategyName, expiry, roles, legs })),
    MARKET_ENVIRONMENT: safeHtml(marketEnvironment),
    THESIS_POINTS: listItems(thesisSentences),
    MACRO_BOX_1_TITLE: safeHtml('Market Sentiment'),
    MACRO_BOX_1_TEXT: safeHtml(firstText(publicData.theme, marketEnvironment)),
    MACRO_BOX_2_TITLE: safeHtml('Gamma Context'),
    MACRO_BOX_2_TEXT: safeHtml(buildGammaMacroText({ symbol, putWall, callWall, gammaContext })),
    MACRO_BOX_3_TITLE: safeHtml('Volatility And Time'),
    MACRO_BOX_3_TEXT: safeHtml(buildVolatilityMacroText({ currentIv, dte, netCredit, netDebit })),
    IV_VALUE: safeHtml(formatVolatility(currentIv)),
    PUT_GAMMA_WALL: safeHtml(formatStrike(putWall) || 'N/A'),
    CALL_GAMMA_WALL: safeHtml(formatStrike(callWall) || 'N/A'),
    COMPANY_HEADLINE: safeHtml(`${symbol} Context - Price, Catalysts, And Risk Checks`),
    PRICE_JOURNEY_HTML: buildPriceJourneyRows({ currentPrice, putWall, callWall, lowBreakeven, highBreakeven }),
    COMPANY_NEWS_BULLETS: listItems(buildCompanyNewsPoints({ item, lifecycle, advisor })),
    COMPANY_HEADWINDS: listItems(buildHeadwindPoints({ item, currentPrice, roles, maxLoss })),
    COMPANY_TAILWINDS: listItems(buildTailwindPoints({ item, advisor, putWall, callWall, dte })),
    ANALYST_COUNT: safeHtml(firstFiniteNumber(lifecycle.analyst?.count, item.analyst?.count) ?? 'N/A'),
    ANALYST_CONSENSUS: safeHtml(firstText(lifecycle.analyst?.consensus, item.analyst?.consensus, 'Research data pending')),
    ANALYST_BUY_PCT: safeHtml(clamp(firstFiniteNumber(lifecycle.analyst?.buyPct, item.analyst?.buyPct) ?? 0, 0, 100)),
    ANALYST_HOLD_PCT: safeHtml(clamp(firstFiniteNumber(lifecycle.analyst?.holdPct, item.analyst?.holdPct) ?? 100, 0, 100)),
    ANALYST_SELL_PCT: safeHtml(clamp(firstFiniteNumber(lifecycle.analyst?.sellPct, item.analyst?.sellPct) ?? 0, 0, 100)),
    ANALYST_TARGET_LOW: safeHtml(formatMoney(firstFiniteNumber(lifecycle.analyst?.targetLow, item.analyst?.targetLow), { digits: 2 }) || 'N/A'),
    ANALYST_TARGET_HIGH: safeHtml(formatMoney(firstFiniteNumber(lifecycle.analyst?.targetHigh, item.analyst?.targetHigh), { digits: 2 }) || 'N/A'),
    ANALYST_NUANCE: safeHtml(firstText(lifecycle.analyst?.nuance, item.analyst?.nuance, 'No analyst consensus feed was attached to this generated recommendation.')),
    SR_LEVELS_HTML: buildSupportResistanceRows({ roles, currentPrice, putWall, callWall, lowBreakeven, highBreakeven }),
    GAMMA_WALL_EXPLANATION: safeHtml(buildGammaExplanation({ symbol, putWall, callWall, gammaContext })),
    GAMMA_CHART_SVG: buildGammaChartSvg({ gammaContext, roles, currentPrice, putWall, callWall }),
    GAMMA_ALIGNMENT_POINTS: listItems(buildGammaAlignmentPoints({ roles, currentPrice, putWall, callWall })),
    RATIONALE_POINTS: listItems(rationalePoints),
    LONG_PUT_STRIKE: safeHtml(formatStrike(roles.longPut?.strike) || 'N/A'),
    SHORT_PUT_STRIKE: safeHtml(formatStrike(roles.shortPut?.strike) || 'N/A'),
    SHORT_CALL_STRIKE: safeHtml(formatStrike(roles.shortCall?.strike) || 'N/A'),
    LONG_CALL_STRIKE: safeHtml(formatStrike(roles.longCall?.strike) || 'N/A'),
    LONG_PUT_PREMIUM: safeHtml(formatMoney(roles.longPut?.premium, { digits: 2 }) || 'N/A'),
    SHORT_PUT_PREMIUM: safeHtml(formatMoney(roles.shortPut?.premium, { digits: 2 }) || 'N/A'),
    SHORT_CALL_PREMIUM: safeHtml(formatMoney(roles.shortCall?.premium, { digits: 2 }) || 'N/A'),
    LONG_CALL_PREMIUM: safeHtml(formatMoney(roles.longCall?.premium, { digits: 2 }) || 'N/A'),
    MA_SEGMENT: safeHtml(buildMovingAverageSegment(indicators)),
    EXECUTION_TABLE_ROWS: buildExecutionRows(legs),
    ESTIMATED_SLIPPAGE: safeHtml(estimatedSlippage(legs)),
    MID_MARKET_PRICE: safeHtml(formatMidMarketPrice({ netCredit, netDebit })),
    MARGIN_PER_CONTRACT: safeHtml(formatMoney(maxLoss, { compact: true }) || 'Review required'),
    THETA_VALUE: safeHtml(formatTheta(greeks.netTheta ?? greeks.theta)),
    THETA_EXPLANATION: safeHtml(buildThetaExplanation({ greeks, dte })),
    VEGA_VALUE: safeHtml(formatVega(greeks.netVega ?? greeks.vega)),
    VEGA_EXPLANATION: safeHtml(buildVegaExplanation({ greeks, currentIv })),
    EVENT_RISK_ROWS: buildEventRiskRows({ expiry, dte, symbol }),
    THETA_SCHEDULE_ROWS: buildThetaScheduleRows({ dte, greeks }),
    EXIT_PROFIT_TRIGGER: safeHtml(buildProfitExitTrigger({ netCredit, maxProfit })),
    EXIT_PROFIT_DETAIL: safeHtml('Close or reduce the position when target premium capture is reached. Do not wait for max profit if liquidity, volatility, or gamma risk deteriorates.'),
    EXIT_STOP_TRIGGER: safeHtml(buildStopExitTrigger({ netCredit, maxLoss, roles })),
    EXIT_STOP_DETAIL: safeHtml(firstText(item.riskNotes, 'Close the spread if price breaches the planned invalidation zone or if losses exceed the pre-defined risk budget.')),
    EXIT_TIME_TRIGGER: safeHtml(buildTimeExitTrigger({ expiry, dte })),
    EXIT_TIME_DETAIL: safeHtml(firstText(item.exit, 'Exit before expiration week gamma risk dominates the original thesis. Avoid holding through expiration unless the admin explicitly approves assignment and pin risk.')),
    EXIT_ADJUST_TRIGGER: safeHtml('Price approaches either short strike or liquidity materially worsens'),
    EXIT_ADJUST_DETAIL: safeHtml('Consider rolling only when the new spread preserves defined risk and improves the credit/risk profile. Prefer closing if adjustment requires chasing price.'),
    CAPITAL_TABLE_ROWS: buildCapitalRows({ maxLoss }),
    STRATEGY_TABLE_ROWS: buildStrategyRows({ strategyName, maxProfit, maxLoss, oddsOfProfit, margin: maxLoss }),
    ALT_STRATEGY_TABLE_ROWS: buildAlternativeStrategyRows({ item, maxLoss }),
    SCORE_INTERPRETATION: safeHtml(buildScoreInterpretation({ tradeScore, strategyName })),
    SCORE_FACTORS: listItems(buildScoreFactors({ tradeScore, advisor, gammaContext, currentIv, maxLoss })),
    RSI_VALUE: safeHtml(formatIndicator(firstFiniteNumber(indicators.rsi14, indicators.rsi))),
    RSI_SIGNAL: safeHtml(rsiSignal(firstFiniteNumber(indicators.rsi14, indicators.rsi))),
    RSI_DESCRIPTION: safeHtml(rsiDescription(firstFiniteNumber(indicators.rsi14, indicators.rsi))),
    IV_RANK: safeHtml(formatIndicator(firstFiniteNumber(indicators.ivRank, indicators.iv_rank, item.ivContext?.ivRank))),
    CURRENT_IV: safeHtml(formatVolatilityNumber(currentIv)),
    HISTORICAL_VOL: safeHtml(formatIndicator(firstFiniteNumber(indicators.historicalVol, indicators.hv30, indicators.historical_vol, item.ivContext?.historicalVol))),
    SMA_20: safeHtml(formatMoney(firstFiniteNumber(indicators.sma20, indicators.sma_20), { digits: 2 }) || 'N/A'),
    SMA_50: safeHtml(formatMoney(firstFiniteNumber(indicators.sma50, indicators.sma_50), { digits: 2 }) || 'N/A'),
    SMA_100: safeHtml(formatMoney(firstFiniteNumber(indicators.sma100, indicators.sma_100), { digits: 2 }) || 'N/A'),
    MA_SIGNAL: safeHtml(movingAverageSignal(indicators)),
    MA_DESCRIPTION: safeHtml(movingAverageDescription(indicators)),
    MACD_LINE: safeHtml(formatIndicator(firstFiniteNumber(indicators.macdLine, indicators.macd_line))),
    MACD_SIGNAL_LINE: safeHtml(formatIndicator(firstFiniteNumber(indicators.macdSignal, indicators.macd_signal))),
    MACD_HISTOGRAM: safeHtml(formatIndicator(firstFiniteNumber(indicators.macdHistogram, indicators.macd_histogram))),
    MACD_DESCRIPTION: safeHtml('MACD data is included when supplied by the market analysis API; otherwise use price, RSI, and moving-average context as the primary technical checks.'),
    BB_UPPER: safeHtml(formatMoney(firstFiniteNumber(indicators.bollingerUpper, indicators.bbUpper), { digits: 2 }) || 'N/A'),
    BB_MIDDLE: safeHtml(formatMoney(firstFiniteNumber(indicators.bollingerMiddle, indicators.bbMiddle, indicators.sma20), { digits: 2 }) || 'N/A'),
    BB_LOWER: safeHtml(formatMoney(firstFiniteNumber(indicators.bollingerLower, indicators.bbLower), { digits: 2 }) || 'N/A'),
    BB_WIDTH: safeHtml(formatIndicator(firstFiniteNumber(indicators.bollingerWidth, indicators.bbWidth))),
    BB_DESCRIPTION: safeHtml('Bollinger width is used as a volatility expansion/compression check against the selected spread width.'),
    MAX_PAIN_SCENARIO: safeHtml(buildMaxPainScenario({ symbol, roles, maxLoss })),
    EARNINGS_RISK: safeHtml(firstText(lifecycle.earningsRisk, item.earningsRisk, 'Confirm the next earnings date before entry. Do not hold through earnings unless that risk is explicitly intended.')),
    EVENT_RISK: safeHtml(firstText(lifecycle.eventRisk, item.eventRisk, 'Monitor macro releases, sector headlines, and scheduled company events while the position is open.')),
    MANAGEMENT_PLAN: safeHtml(firstText(item.exit, item.entry, 'Enter only when quoted spreads are liquid. Size by max loss, target partial premium capture, and exit early if the thesis invalidates.')),
    WHY_THIS_STRATEGY: safeHtml(firstText(advisor.rationale, item.thesis, `${strategyName} was selected because it gives a defined-risk way to express the current market thesis.`)),
    WHY_THESE_STRIKES: safeHtml(buildStrikeSelectionReason({ roles, putWall, callWall })),
    WHY_THIS_EXPIRY: safeHtml(buildExpiryReason({ expiry, dte })),
    ALTERNATIVES_TABLE_ROWS: buildAlternativesRows({ item, maxLoss }),
    TRADE_SPEC_ROWS: buildTradeSpecRows({
      symbol,
      companyName,
      strategyName,
      expiry,
      dte,
      roles,
      netCredit,
      netDebit,
      maxProfit,
      maxLoss,
      lowBreakeven,
      highBreakeven,
    }),
  };

  return hasEnrichedRecommendationAnalysis(item)
    ? buildEnrichedRecommendationReportData({ item, publicData, generatedAt, baseData: data })
    : data;
}

function hasEnrichedRecommendationAnalysis(item) {
  const analysis = plainObject(item.analysis);
  return Boolean(
    Object.keys(plainObject(analysis.strategyRationale)).length
      || Object.keys(plainObject(analysis.technicalIndicators)).length
      || Object.keys(plainObject(analysis.riskAnalysis)).length,
  );
}

function buildEnrichedRecommendationReportData({ item, publicData, generatedAt, baseData }) {
  const analysis = plainObject(item.analysis);
  const rationale = plainObject(analysis.strategyRationale);
  const tech = plainObject(analysis.technicalIndicators);
  const theta = plainObject(analysis.thetaDecaySchedule);
  const risk = plainObject(analysis.riskAnalysis);
  const gamma = plainObject(item.gammaData ?? item.lifecycle?.gammaContext);
  const greeks = plainObject(item.greeks ?? item.lifecycle?.calculation?.greeks);
  const sentiment = plainObject(item.sentiment);
  const composite = plainObject(sentiment.composite);
  const legs = normalizeLegs(item.legs);
  const roles = assignLegRoles(legs);

  const symbol = textValue(item.symbol ?? publicData.recommendationSymbol ?? 'PICK');
  const strategyName = textValue(item.strategy ?? 'Defined-Risk Options Spread');
  const companyName = companyDisplayName(symbol, item.companyName);
  const spot = firstFiniteNumber(item.spotPrice, item.price, item.underlyingPrice, item.lifecycle?.marketData?.spotPrice);
  const expiry = textValue(item.expiry ?? item.lifecycle?.calculation?.expiry ?? '');
  const dte = firstFiniteNumber(item.dte, item.lifecycle?.calculation?.dte) ?? daysToExpiry(expiry, publicData.tradeDate ?? generatedAt);
  const maxProfit = firstFiniteNumber(item.maxProfit, item.lifecycle?.calculation?.maxProfit);
  const maxLoss = firstFiniteNumber(item.maxLoss, item.lifecycle?.calculation?.maxLoss);
  const netCredit = firstFiniteNumber(item.netCredit, item.lifecycle?.calculation?.netCredit);
  const oddsOfProfit = firstFiniteNumber(item.oddsOfProfit, item.winRate, item.lifecycle?.calculation?.oddsOfProfit);
  const rewardRisk = firstFiniteNumber(item.rewardRisk, item.lifecycle?.calculation?.rewardRisk);
  const shortPutStrike = firstFiniteNumber(roles.shortPut?.strike);
  const shortCallStrike = firstFiniteNumber(roles.shortCall?.strike);
  const lowBreakeven = firstFiniteNumber(item.breakevens?.lower, item.breakevens?.low)
    ?? (shortPutStrike != null && netCredit != null ? shortPutStrike - netCredit : null);
  const highBreakeven = firstFiniteNumber(item.breakevens?.upper, item.breakevens?.high)
    ?? (shortCallStrike != null && netCredit != null ? shortCallStrike + netCredit : null);
  const currentIv = firstFiniteNumber(item.ivContext?.currentIV, item.ivContext?.currentIv, tech.impliedVolatility?.currentIV);
  const ivRank = firstFiniteNumber(item.ivContext?.ivRank, tech.impliedVolatility?.ivRank);
  const putWall = firstFiniteNumber(gamma.put_wall, gamma.putWall, gamma.putWallStrike);
  const callWall = firstFiniteNumber(gamma.call_wall, gamma.callWall, gamma.callWallStrike);
  const tradeScore = Math.round(oddsOfProfit ?? firstFiniteNumber(item.confidenceScore, item.score) ?? scoreFromRecommendation(item));

  const supportLevels = normalizeLevelRows(tech.supportResistance?.support);
  const resistanceLevels = normalizeLevelRows(tech.supportResistance?.resistance);
  const keyLevels = plainObject(item.keyLevels);
  const supportFallbacks = Array.isArray(keyLevels.support) ? keyLevels.support : [];
  const resistanceFallbacks = Array.isArray(keyLevels.resistance) ? keyLevels.resistance : [];

  return {
    ...baseData,
    HAS_MACRO: sentiment.summary || sentiment.keyDrivers || sentiment.sectorContext ? '1' : baseData.HAS_MACRO,
    HAS_COMPANY: sentiment.summary || sentiment.keyDrivers ? '1' : baseData.HAS_COMPANY,
    HAS_ANALYST: item.analyst || item.lifecycle?.analyst ? baseData.HAS_ANALYST : '',
    SYMBOL: safeHtml(symbol),
    COMPANY_NAME: safeHtml(companyName),
    STRATEGY_NAME: safeHtml(strategyName),
    REPORT_DATE: safeHtml(formatReportDate(publicData.tradeDate ?? item.generatedAt ?? generatedAt, item.generatedAt ?? generatedAt)),
    REPORT_TIME: safeHtml(formatReportTime(generatedAt)),
    EXPIRATION_DATE: safeHtml(expiry || 'Review required'),
    DAYS_TO_EXPIRY: safeHtml(dte ?? 'N/A'),
    CURRENT_PRICE: safeHtml(formatTemplateMoney(spot)),
    PRICE_CHANGE: safeHtml(formatTemplatePriceChange(item.priceChange)),
    MAX_PROFIT: safeHtml(formatTemplateMoney(maxProfit)),
    MAX_PROFIT_DESC: safeHtml(maxProfit == null
      ? 'awaiting priced legs'
      : `Full credit kept if ${symbol} stays between short strikes at expiration`),
    MAX_LOSS: safeHtml(formatTemplateMoney(maxLoss)),
    MAX_LOSS_DESC: safeHtml(maxLoss == null ? 'requires admin review' : 'Spread width minus credit received per contract'),
    WIN_RATE: safeHtml(oddsOfProfit == null ? 'N/A' : Math.round(oddsOfProfit)),
    WIN_RATE_DESC: safeHtml('Based on strike positioning and delta probability'),
    RISK_REWARD: safeHtml(rewardRisk == null ? 'N/A' : `${round(rewardRisk, 2)}x`),
    RISK_REWARD_DESC: safeHtml('Max profit / max loss ratio'),
    BREAKEVEN_LOW: safeHtml(formatTemplateMoney(lowBreakeven)),
    BREAKEVEN_HIGH: safeHtml(formatTemplateMoney(highBreakeven)),
    BREAKEVEN_RANGE: safeHtml(formatTemplateRange(lowBreakeven, highBreakeven)),
    BREAKEVEN_RANGE_DESC: safeHtml(lowBreakeven != null && highBreakeven != null
      ? `Profit zone at expiration (${formatTemplateMoney(highBreakeven - lowBreakeven)} wide)`
      : 'profit zone at expiration'),
    TRADE_SCORE: safeHtml(tradeScore),
    CONFIDENCE_LEVEL: safeHtml(enrichedConfidenceLabel(tradeScore)),
    CONFIDENCE_THRESHOLD_LABEL: safeHtml(oddsOfProfit == null ? baseData.CONFIDENCE_THRESHOLD_LABEL : `PoP: ${Math.round(oddsOfProfit)}%`),
    TRADE_CONFIG: safeHtml(`${strategyName} on ${symbol} @ ${formatTemplateMoney(spot)}`),
    MARKET_ENVIRONMENT: safeHtml(firstSentences(tech.impliedVolatility?.description, 2) || baseData.MARKET_ENVIRONMENT),
    THESIS_POINTS: listItems([
      firstSentence(rationale.whyThisStrategy),
      firstSentence(rationale.whyTheseStrikes),
      firstSentence(rationale.whyThisExpiry),
    ].filter(Boolean)),
    WHY_THIS_STRATEGY: safeHtml(firstText(rationale.whyThisStrategy, baseData.WHY_THIS_STRATEGY)),
    WHY_THESE_STRIKES: safeHtml(firstText(rationale.whyTheseStrikes, baseData.WHY_THESE_STRIKES)),
    WHY_THIS_EXPIRY: safeHtml(firstText(rationale.whyThisExpiry, baseData.WHY_THIS_EXPIRY)),
    RATIONALE_POINTS: listItems([rationale.whyThisStrategy, rationale.whyTheseStrikes].filter(Boolean)),
    MACRO_BOX_1_TITLE: safeHtml('Market Sentiment'),
    MACRO_BOX_1_TEXT: safeHtml(buildEnrichedSentimentSummary(sentiment, composite)),
    MACRO_BOX_2_TITLE: safeHtml('Sector Theme'),
    MACRO_BOX_2_TEXT: safeHtml(firstText(sentiment.sectorContext, 'No sector-specific themes identified.')),
    MACRO_BOX_3_TITLE: safeHtml('Social Mood'),
    MACRO_BOX_3_TEXT: safeHtml(firstText(sentiment.socialSentiment, 'No significant social media activity detected.')),
    IV_VALUE: safeHtml(formatEnrichedIvValue(currentIv, ivRank)),
    PUT_GAMMA_WALL: safeHtml(formatTemplateMoney(putWall)),
    CALL_GAMMA_WALL: safeHtml(formatTemplateMoney(callWall)),
    COMPANY_HEADLINE: safeHtml(`${companyName} (${symbol}) - ${strategyName} Analysis`),
    PRICE_JOURNEY_HTML: buildEnrichedPriceJourneyRows({
      spot,
      putWall,
      callWall,
      supports: supportLevels.length ? supportLevels.map((level) => level.level) : supportFallbacks,
      resistances: resistanceLevels.length ? resistanceLevels.map((level) => level.level) : resistanceFallbacks,
    }),
    COMPANY_NEWS_BULLETS: listItems(sentimentDrivers(sentiment).slice(0, 4).map((driver) => driver.factor)),
    COMPANY_HEADWINDS: listItems(sentimentDrivers(sentiment).filter((driver) => driver.impact === 'negative').slice(0, 3).map((driver) => driver.factor)),
    COMPANY_TAILWINDS: listItems(sentimentDrivers(sentiment).filter((driver) => driver.impact === 'positive').slice(0, 3).map((driver) => driver.factor)),
    ANALYST_CONSENSUS: safeHtml(baseData.ANALYST_CONSENSUS || sentimentConsensus(sentiment)),
    ANALYST_NUANCE: safeHtml(firstText(item.lifecycle?.analyst?.nuance, item.analyst?.nuance, sentiment.sectorContext, baseData.ANALYST_NUANCE)),
    SR_LEVELS_HTML: buildEnrichedSupportResistanceRows(supportLevels, resistanceLevels),
    GAMMA_WALL_EXPLANATION: safeHtml(buildEnrichedGammaExplanation({ putWall, callWall, gamma })),
    GAMMA_CHART_SVG: buildEnrichedGammaChartSvg({ gamma, spot, putWall, callWall }) || baseData.GAMMA_CHART_SVG,
    GAMMA_ALIGNMENT_POINTS: listItems(buildEnrichedGammaAlignmentPoints({
      spot,
      putWall,
      callWall,
      shortPutStrike,
      shortCallStrike,
    })),
    LONG_PUT_STRIKE: safeHtml(formatTemplateMoney(roles.longPut?.strike)),
    SHORT_PUT_STRIKE: safeHtml(formatTemplateMoney(roles.shortPut?.strike)),
    SHORT_CALL_STRIKE: safeHtml(formatTemplateMoney(roles.shortCall?.strike)),
    LONG_CALL_STRIKE: safeHtml(formatTemplateMoney(roles.longCall?.strike)),
    LONG_PUT_PREMIUM: safeHtml(formatTemplateMoney(roles.longPut?.premium)),
    SHORT_PUT_PREMIUM: safeHtml(formatTemplateMoney(roles.shortPut?.premium)),
    SHORT_CALL_PREMIUM: safeHtml(formatTemplateMoney(roles.shortCall?.premium)),
    LONG_CALL_PREMIUM: safeHtml(formatTemplateMoney(roles.longCall?.premium)),
    EXECUTION_TABLE_ROWS: buildEnrichedExecutionRows(legs),
    MID_MARKET_PRICE: safeHtml(formatTemplateMoney(netCredit)),
    ESTIMATED_SLIPPAGE: safeHtml('model-estimated from live spread widths'),
    MARGIN_PER_CONTRACT: safeHtml(formatTemplateMoney(maxLoss)),
    THETA_VALUE: safeHtml(formatTemplateMoney(greeks.netTheta ?? greeks.theta)),
    THETA_EXPLANATION: safeHtml(firstText(theta.description, baseData.THETA_EXPLANATION)),
    VEGA_VALUE: safeHtml(formatTemplateNumber(greeks.netVega ?? greeks.vega, 4)),
    VEGA_EXPLANATION: safeHtml('Net vega exposure from all legs combined.'),
    THETA_SCHEDULE_ROWS: buildThetaRowsFromAnalysis(theta.dailyDecay) || baseData.THETA_SCHEDULE_ROWS,
    EXIT_PROFIT_TRIGGER: safeHtml(firstText(theta.earlyCloseRecommendation, maxProfit == null ? '' : `Position reaches 50% of max profit (${formatTemplateMoney(maxProfit * 0.5)})`, baseData.EXIT_PROFIT_TRIGGER)),
    EXIT_PROFIT_DETAIL: safeHtml('Take profit when net premium decays to the target level.'),
    EXIT_STOP_TRIGGER: safeHtml(`${symbol} breaches short strike`),
    EXIT_STOP_DETAIL: safeHtml(firstSentence(risk.managementPlan) || baseData.EXIT_STOP_DETAIL),
    EXIT_TIME_TRIGGER: safeHtml('2-3 DTE remaining'),
    EXIT_TIME_DETAIL: safeHtml('Close position to avoid pin risk and gamma acceleration near expiry.'),
    EXIT_ADJUST_TRIGGER: safeHtml('Delta exceeds +/-0.30'),
    EXIT_ADJUST_DETAIL: safeHtml('Roll tested side to maintain delta neutrality only if the new trade keeps defined risk.'),
    CAPITAL_TABLE_ROWS: buildEnrichedCapitalRows(maxLoss),
    STRATEGY_TABLE_ROWS: buildEnrichedStrategyRows({ strategyName, maxProfit, maxLoss, oddsOfProfit }),
    ALT_STRATEGY_TABLE_ROWS: buildAlternativeRowsFromAnalysis(rationale.alternativesConsidered, 3) || baseData.ALT_STRATEGY_TABLE_ROWS,
    ALTERNATIVES_TABLE_ROWS: buildAlternativeRowsFromAnalysis(rationale.alternativesConsidered) || baseData.ALTERNATIVES_TABLE_ROWS,
    SCORE_INTERPRETATION: safeHtml(oddsOfProfit == null ? baseData.SCORE_INTERPRETATION : `This trade scores ${Math.round(oddsOfProfit)}/100 - ${oddsOfProfit >= 60 ? 'meets' : 'below'} the 60+ recommended threshold.`),
    SCORE_FACTORS: listItems([
      'Score based on gamma wall analysis, OI concentration, IV levels, and strike positioning.',
      oddsOfProfit == null ? null : `Probability-of-profit score: ${Math.round(oddsOfProfit)}%.`,
    ].filter(Boolean)),
    RSI_VALUE: safeHtml(formatTemplateNumber(tech.rsi?.value, 1)),
    RSI_SIGNAL: safeHtml(firstText(tech.rsi?.signal, baseData.RSI_SIGNAL)),
    RSI_DESCRIPTION: safeHtml(firstText(tech.rsi?.description, baseData.RSI_DESCRIPTION)),
    IV_RANK: safeHtml(formatTemplateNumber(ivRank, 0)),
    CURRENT_IV: safeHtml(formatTemplateNumber(normalizePercentValue(currentIv), 1)),
    HISTORICAL_VOL: safeHtml(formatTemplateNumber(normalizePercentValue(tech.impliedVolatility?.historicalVol30), 1)),
    SMA_20: safeHtml(formatTemplateMoney(tech.movingAverages?.sma20)),
    SMA_50: safeHtml(formatTemplateMoney(tech.movingAverages?.sma50)),
    SMA_100: safeHtml(formatTemplateMoney(tech.movingAverages?.sma100)),
    MA_SIGNAL: safeHtml(firstText(tech.movingAverages?.signal, baseData.MA_SIGNAL)),
    MA_DESCRIPTION: safeHtml(firstText(tech.movingAverages?.description, baseData.MA_DESCRIPTION)),
    MA_SEGMENT: buildMovingAverageRowsFromAnalysis({ movingAverages: tech.movingAverages, spot }) || baseData.MA_SEGMENT,
    MACD_LINE: safeHtml(formatTemplateNumber(tech.macd?.macdLine, 2)),
    MACD_SIGNAL_LINE: safeHtml(formatTemplateNumber(tech.macd?.signalLine, 2)),
    MACD_HISTOGRAM: safeHtml(formatTemplateNumber(tech.macd?.histogram, 2)),
    MACD_DESCRIPTION: safeHtml(firstText(tech.macd?.description, baseData.MACD_DESCRIPTION)),
    BB_UPPER: safeHtml(formatTemplateMoney(tech.bollingerBands?.upper)),
    BB_MIDDLE: safeHtml(formatTemplateMoney(tech.bollingerBands?.middle)),
    BB_LOWER: safeHtml(formatTemplateMoney(tech.bollingerBands?.lower)),
    BB_WIDTH: safeHtml(formatTemplateNumber(tech.bollingerBands?.width, 1)),
    BB_DESCRIPTION: safeHtml(firstText(tech.bollingerBands?.description, baseData.BB_DESCRIPTION)),
    MAX_PAIN_SCENARIO: safeHtml(firstText(risk.maxPainScenario, baseData.MAX_PAIN_SCENARIO)),
    EARNINGS_RISK: safeHtml(firstText(risk.earningsRisk, baseData.EARNINGS_RISK)),
    EVENT_RISK: safeHtml(firstText(risk.eventRisk, baseData.EVENT_RISK)),
    MANAGEMENT_PLAN: safeHtml(firstText(risk.managementPlan, baseData.MANAGEMENT_PLAN)),
    WHY_THIS_STRATEGY: safeHtml(firstText(rationale.whyThisStrategy, baseData.WHY_THIS_STRATEGY)),
    WHY_THESE_STRIKES: safeHtml(firstText(rationale.whyTheseStrikes, baseData.WHY_THESE_STRIKES)),
    WHY_THIS_EXPIRY: safeHtml(firstText(rationale.whyThisExpiry, baseData.WHY_THIS_EXPIRY)),
    TRADE_SPEC_ROWS: buildEnrichedTradeSpecRows({
      symbol,
      companyName,
      strategyName,
      expiry,
      dte,
      roles,
      netCredit,
      maxProfit,
      maxLoss,
      lowBreakeven,
      highBreakeven,
      spot,
    }),
  };
}

const COMPANY_NAMES = Object.freeze({
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  NVDA: 'Nvidia',
  AMZN: 'Amazon',
  GOOG: 'Alphabet',
  GOOGL: 'Alphabet',
  META: 'Meta Platforms',
  TSLA: 'Tesla',
  AMD: 'AMD',
  AVGO: 'Broadcom',
  NFLX: 'Netflix',
  ADBE: 'Adobe',
  CRM: 'Salesforce',
  INTC: 'Intel',
  PLTR: 'Palantir',
  COIN: 'Coinbase',
  JPM: 'JPMorgan',
  BAC: 'Bank of America',
  GS: 'Goldman Sachs',
  MS: 'Morgan Stanley',
  C: 'Citigroup',
  WFC: 'Wells Fargo',
  XOM: 'Exxon Mobil',
  CVX: 'Chevron',
  CAT: 'Caterpillar',
  DE: 'John Deere',
  HON: 'Honeywell',
  MMM: '3M Company',
  BA: 'Boeing',
  LMT: 'Lockheed Martin',
  RTX: 'RTX Corp',
  GE: 'GE Aerospace',
  UNH: 'UnitedHealth',
  PFE: 'Pfizer',
  JNJ: 'Johnson & Johnson',
  MRK: 'Merck',
  ABBV: 'AbbVie',
  LLY: 'Eli Lilly',
  WMT: 'Walmart',
  COST: 'Costco',
  TGT: 'Target',
  PG: 'Procter & Gamble',
  KO: 'Coca-Cola',
  PEP: 'PepsiCo',
  HD: 'Home Depot',
  MCD: 'McDonald\'s',
  NKE: 'Nike',
  NUE: 'Nucor',
  FCX: 'Freeport-McMoRan',
  NEM: 'Newmont',
  NEE: 'NextEra Energy',
  BABA: 'Alibaba',
  BIDU: 'Baidu',
  JD: 'JD.com',
  PDD: 'PDD Holdings',
  NIO: 'NIO',
  DIS: 'Walt Disney',
  SPY: 'S&P 500 ETF',
  QQQ: 'Nasdaq 100 ETF',
  IWM: 'Russell 2000 ETF',
  DIA: 'Dow Jones ETF',
  TLT: 'Treasury Bond ETF',
  GLD: 'Gold ETF',
  SLV: 'Silver ETF',
  XLF: 'Financial Select ETF',
  XLK: 'Tech Select ETF',
  XLE: 'Energy Select ETF',
  XLY: 'Consumer Disc ETF',
  XLI: 'Industrial Select ETF',
  XLP: 'Consumer Staples ETF',
  XLU: 'Utilities Select ETF',
  XLB: 'Materials Select ETF',
});

function companyDisplayName(symbol, fallback) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  const fallbackText = textValue(fallback);
  return COMPANY_NAMES[ticker] ?? (fallbackText && fallbackText !== ticker ? fallbackText : ticker);
}

function formatTemplateMoney(value) {
  if (value == null || value === '') return 'N/A';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  const rounded = roundHalfEven(numberValue, 2);
  return `$${rounded.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTemplateNumber(value, digits = 2) {
  if (value == null || value === '') return 'N/A';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  return numberValue.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatTemplateRange(low, high) {
  if (low != null && high != null) return `${formatTemplateMoney(low)} - ${formatTemplateMoney(high)}`;
  if (low != null) return formatTemplateMoney(low);
  if (high != null) return formatTemplateMoney(high);
  return 'N/A';
}

function formatTemplatePriceChange(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue === 0) return '';
  return `(${numberValue > 0 ? '+' : ''}${numberValue.toFixed(2)})`;
}

function roundHalfEven(value, digits = 0) {
  const factor = 10 ** digits;
  const scaled = Number(value) * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-10;
  if (Math.abs(diff - 0.5) < epsilon) {
    return (floor % 2 === 0 ? floor : floor + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

function firstSentence(value, maxLength = 220) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const [sentence] = clean.split(/(?<=\.)\s+/);
  const result = sentence || clean;
  return result.length > maxLength ? `${result.slice(0, maxLength - 1).trim()}...` : result;
}

function firstSentences(value, count = 2) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.split(/(?<=\.)\s+/).filter(Boolean);
  return sentences.slice(0, count).join(' ');
}

function normalizePercentValue(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return numberValue <= 1 ? numberValue * 100 : numberValue;
}

function formatEnrichedIvValue(currentIv, ivRank) {
  const percent = normalizePercentValue(currentIv);
  const ivText = percent == null ? 'N/A' : `${round(percent, 1)}%`;
  return ivRank == null ? ivText : `${ivText} (Rank: ${Math.round(ivRank)})`;
}

function buildEnrichedSentimentSummary(sentiment, composite) {
  const score = firstFiniteNumber(composite.score, sentiment.score);
  const label = firstText(composite.label, sentiment.label, 'N/A');
  const detectedEngines = Object.keys(plainObject(sentiment.engines)).length;
  const activeEngines = firstFiniteNumber(sentiment.activeEngines) ?? (detectedEngines || 1);
  const confidence = firstFiniteNumber(composite.confidence, sentiment.confidence);
  const confidenceText = confidence == null ? 'N/A' : `${Math.round(confidence * 100)}%`;
  return `Composite score: ${score ?? 'N/A'}/100 (${label}) from ${activeEngines} AI engines. Confidence: ${confidenceText}.`;
}

function sentimentDrivers(sentiment) {
  const drivers = sentiment.keyDrivers;
  return Array.isArray(drivers)
    ? drivers.map((driver) => ({
        factor: firstText(driver?.factor, driver?.text, driver?.headline),
        impact: String(driver?.impact ?? '').trim().toLowerCase(),
      })).filter((driver) => driver.factor)
    : [];
}

function sentimentConsensus(sentiment) {
  const score = firstFiniteNumber(sentiment.composite?.score, sentiment.score) ?? 50;
  if (score > 60) return 'Buy';
  if (score < 40) return 'Sell';
  return 'Hold';
}

function normalizeLevelRows(value) {
  return Array.isArray(value)
    ? value.map((entry) => ({
        level: firstFiniteNumber(entry?.level, entry?.price, entry),
        strength: firstText(entry?.strength),
        description: firstText(entry?.description, entry?.text),
      })).filter((entry) => entry.level != null)
    : [];
}

function buildEnrichedPriceJourneyRows({ spot, putWall, callWall, supports, resistances }) {
  const support = Array.isArray(supports) ? supports.map(Number).filter(Number.isFinite).sort((a, b) => a - b)[0] : null;
  const resistanceValues = Array.isArray(resistances) ? resistances.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const resistance = resistanceValues.length ? resistanceValues[resistanceValues.length - 1] : null;
  const rows = [
    support != null ? ['Key Support', formatTemplateMoney(support)] : null,
    putWall != null ? ['Put Gamma Wall', formatTemplateMoney(putWall)] : null,
    spot != null ? ['Current Price', formatTemplateMoney(spot), 'highlight-row'] : null,
    callWall != null ? ['Call Gamma Wall', formatTemplateMoney(callWall)] : null,
    resistance != null ? ['Key Resistance', formatTemplateMoney(resistance)] : null,
  ].filter(Boolean);
  return rows.map(([label, price, klass]) =>
    `<tr${klass ? ` class="${klass}"` : ''}><td>${safeHtml(label)}</td><td>${safeHtml(price)}</td></tr>`).join('');
}

function buildEnrichedSupportResistanceRows(supports, resistances) {
  const rows = [
    ...supports.map((entry) => ['Support', formatTemplateMoney(entry.level), entry.strength, entry.description]),
    ...resistances.map((entry) => ['Resistance', formatTemplateMoney(entry.level), entry.strength, entry.description]),
  ];
  return rows.length ? tableRows(rows) : '<tr><td colspan="4">Support and resistance data unavailable.</td></tr>';
}

function buildEnrichedGammaExplanation({ putWall, callWall, gamma }) {
  if (putWall != null && callWall != null) {
    const confidence = firstFiniteNumber(gamma.confidence_score, gamma.confidence);
    const confidenceText = confidence == null ? '' : ` Confidence: ${Math.round(confidence * 100)}%.`;
    return `Gamma walls at ${formatTemplateMoney(putWall)} (put) and ${formatTemplateMoney(callWall)} (call) define dealer-enforced boundaries.${confidenceText}`;
  }
  return 'Gamma wall data was not attached to this pick; validate support and resistance before publishing.';
}

function buildEnrichedGammaChartSvg({ gamma, spot, putWall, callWall }) {
  const strikes = Array.isArray(gamma.topStrikes) ? gamma.topStrikes : [];
  const nearby = strikes
    .map((entry) => ({
      strike: firstFiniteNumber(entry.strike),
      volume: (firstFiniteNumber(entry.call_volume, entry.callVolume) ?? 0) + (firstFiniteNumber(entry.put_volume, entry.putVolume) ?? 0),
    }))
    .filter((entry) => entry.strike != null && entry.volume > 0 && (spot == null || Math.abs(entry.strike - spot) < spot * 0.15))
    .sort((left, right) => left.strike - right.strike)
    .slice(0, 12);
  if (!nearby.length) return '';
  const maxVolume = Math.max(...nearby.map((entry) => entry.volume));
  const barWidth = 36;
  const gap = 8;
  const baseLine = 120;
  const chartWidth = nearby.length * (barWidth + gap) + 40;
  const lines = [`<svg viewBox="0 0 ${chartWidth} 145" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:110pt;">`];
  for (const [index, entry] of nearby.entries()) {
    const x = 20 + index * (barWidth + gap);
    const center = x + barWidth / 2;
    const height = Math.max(4, (entry.volume / maxVolume) * 90);
    const y = baseLine - height;
    const label = entry.strike === putWall ? 'PUT WALL' : entry.strike === callWall ? 'CALL WALL' : Math.abs(entry.strike - spot) <= spot * 0.01 ? 'SPOT' : '';
    const color = label === 'PUT WALL' ? '#dc2626' : label === 'CALL WALL' ? '#059669' : label === 'SPOT' ? '#C9A96E' : '#9CA3AF';
    lines.push(`<rect x="${x}" y="${Math.round(y)}" width="${barWidth}" height="${Math.round(height)}" fill="${color}" rx="2"/>`);
    lines.push(`<text x="${Math.round(center)}" y="${baseLine + 10}" text-anchor="middle" font-size="6" fill="#4B5563">$${Math.round(entry.strike)}</text>`);
    if (label) {
      lines.push(`<text x="${Math.round(center)}" y="${baseLine + 18}" text-anchor="middle" font-size="5" fill="${color}" font-weight="700">${label}</text>`);
    }
  }
  lines.push(`<line x1="15" y1="${baseLine}" x2="${chartWidth - 5}" y2="${baseLine}" stroke="#E6E8EB" stroke-width="0.5"/>`);
  lines.push('</svg>');
  return lines.join('');
}

function buildEnrichedGammaAlignmentPoints({ spot, putWall, callWall, shortPutStrike, shortCallStrike }) {
  const points = [];
  if (shortPutStrike != null && putWall != null) {
    points.push(`Short Put (${formatTemplateMoney(shortPutStrike)}) near Put Wall (${formatTemplateMoney(putWall)}) - dealer buying support.`);
  }
  if (shortCallStrike != null && callWall != null) {
    points.push(`Short Call (${formatTemplateMoney(shortCallStrike)}) near Call Wall (${formatTemplateMoney(callWall)}) - dealer selling pressure.`);
  }
  if (spot != null) points.push(`Current Price (${formatTemplateMoney(spot)}) within gamma band.`);
  if (putWall != null && callWall != null && spot) {
    points.push(`Band width ${formatTemplateMoney(callWall - putWall)} (${round((callWall - putWall) / spot * 100, 1)}% of price).`);
  }
  return points;
}

function buildEnrichedExecutionRows(legs) {
  if (!Array.isArray(legs) || !legs.length) {
    return '<tr><td colspan="8">Leg pricing pending.</td></tr>';
  }
  return legs.map((leg) => `<tr><td>${safeHtml(leg.action)}</td><td>${safeHtml(leg.type)}</td><td>${safeHtml(formatTemplateMoney(leg.strike))}</td><td>${safeHtml(formatTemplateMoney(leg.premium))}</td><td>${safeHtml(formatTemplateNumber(leg.delta, 4))}</td><td>${safeHtml(formatTemplateNumber(normalizePercentValue(leg.iv), 1))}</td><td>${safeHtml(formatTemplateNumber(leg.theta, 4))}</td><td>N/A</td></tr>`).join('');
}

function buildThetaRowsFromAnalysis(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.map((row) => `<tr><td>${safeHtml(row.daysToExpiry ?? '')}d before</td><td>${safeHtml(row.daysToExpiry ?? '')}</td><td>${safeHtml(formatTemplateMoney(row.dailyTheta))}/day</td><td>${safeHtml(formatTemplateMoney(row.cumulativeTheta))}</td></tr>`).join('');
}

function buildEnrichedCapitalRows(maxLoss) {
  const portfolios = [10000, 25000, 50000, 100000];
  return portfolios.map((portfolio, index) => {
    const riskBudget = Math.round(portfolio * 0.02);
    const contracts = maxLoss ? Math.floor(riskBudget / maxLoss) : 0;
    const note = contracts === 0 ? 'Portfolio too small' : `${contracts} contract${contracts > 1 ? 's' : ''}`;
    return `<tr${index === 1 ? ' class="highlight-row"' : ''}><td>${safeHtml(formatTemplateMoney(portfolio))}</td><td>${safeHtml(formatTemplateMoney(riskBudget))}</td><td>${safeHtml(contracts)}</td><td>${safeHtml(contracts ? formatTemplateMoney(contracts * maxLoss) : '--')}</td><td>${safeHtml(note)}</td></tr>`;
  }).join('');
}

function buildEnrichedStrategyRows({ strategyName, maxProfit, maxLoss, oddsOfProfit }) {
  return tableRows([
    [strategyName, formatTemplateMoney(maxProfit), formatTemplateMoney(maxLoss), oddsOfProfit == null ? 'N/A' : `${Math.round(oddsOfProfit)}%`, formatTemplateMoney(maxLoss)],
  ]);
}

function buildAlternativeRowsFromAnalysis(alternatives, limit = Infinity) {
  if (!Array.isArray(alternatives) || alternatives.length === 0) return '';
  return tableRows(alternatives.slice(0, limit).map((alternative) => [
    firstText(alternative.strategy, alternative.name),
    firstText(alternative.reason, alternative.description),
  ]));
}

function buildMovingAverageRowsFromAnalysis({ movingAverages, spot }) {
  const ma = plainObject(movingAverages);
  const rows = [
    ['SMA 20', ma.sma20],
    ['SMA 50', ma.sma50],
    ['SMA 100', ma.sma100],
  ].filter(([, value]) => firstFiniteNumber(value) != null)
    .map(([label, value]) => {
      const numberValue = firstFiniteNumber(value);
      const relation = spot != null && numberValue != null
        ? `${spot > numberValue ? 'Above' : 'Below'} (${Math.abs(round((spot - numberValue) / spot * 100, 1))}%)`
        : 'N/A';
      return [label, formatTemplateMoney(numberValue), relation];
    });
  return rows.length ? tableRows(rows) : '';
}

function buildEnrichedTradeSpecRows({
  symbol,
  companyName,
  strategyName,
  expiry,
  dte,
  roles,
  netCredit,
  maxProfit,
  maxLoss,
  lowBreakeven,
  highBreakeven,
  spot,
}) {
  const profitZone = lowBreakeven != null && highBreakeven != null ? highBreakeven - lowBreakeven : null;
  return tableRows([
    ['Strategy', `${strategyName} (4-legged spread)`],
    ['Underlying', `${symbol} - ${companyName}`],
    ['Expiration', `${expiry || 'Review required'}${dte ? ` (${dte} DTE at entry)` : ''}`],
    ['Put Spread', `Buy ${formatTemplateMoney(roles.longPut?.strike)} Put / Sell ${formatTemplateMoney(roles.shortPut?.strike)} Put`],
    ['Call Spread', `Sell ${formatTemplateMoney(roles.shortCall?.strike)} Call / Buy ${formatTemplateMoney(roles.longCall?.strike)} Call`],
    ['Net Credit', `${formatTemplateMoney(netCredit)} per share (${formatTemplateMoney(netCredit == null ? null : netCredit * 100)} per contract)`],
    ['Max Profit', `${formatTemplateMoney(maxProfit)} per contract (full credit kept)`],
    ['Max Loss', `${formatTemplateMoney(maxLoss)} per contract (spread width minus credit)`],
    ['Break-Even Low', formatTemplateMoney(lowBreakeven)],
    ['Break-Even High', formatTemplateMoney(highBreakeven)],
    ['Profit Zone Width', profitZone == null ? 'N/A' : `${formatTemplateMoney(profitZone)}${spot ? ` (${round(profitZone / spot * 100, 1)}% of current price)` : ''}`],
  ]);
}

function enrichedConfidenceLabel(score) {
  if (score >= 75) return 'HIGH CONFIDENCE';
  if (score >= 60) return 'MODERATE CONFIDENCE';
  return 'SPECULATIVE';
}

async function runWeasyprintRenderer({ inputPath, outputPath, serviceConfig }) {
  const pythonPath = resolvePythonPath(serviceConfig);
  const timeoutMs = Number(serviceConfig.pdf?.renderTimeoutMs) > 0
    ? Number(serviceConfig.pdf.renderTimeoutMs)
    : DEFAULT_RENDER_TIMEOUT_MS;

  await runProcess({
    executable: pythonPath,
    args: [RENDER_SCRIPT, inputPath, outputPath],
    timeoutMs,
    label: 'Institutional PDF renderer',
  });
}

function resolvePythonPath(serviceConfig = {}) {
  return serviceConfig.pdf?.pythonPath
    ?? process.env.WEASYPRINT_PYTHON_PATH
    ?? process.env.PYTHON_PATH
    ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function institutionalRendererName(serviceConfig = {}) {
  const renderer = String(serviceConfig.pdf?.recommendationRenderer ?? 'institutional').trim().toLowerCase();
  if (renderer === 'weasyprint' || renderer === 'chrome') return renderer;
  return 'institutional';
}

async function renderWithChrome({ data, outputPath, tempDir, serviceConfig }) {
  const htmlPath = path.join(tempDir, 'report.html');
  await fsp.writeFile(htmlPath, await buildReportHtml(data), 'utf8');
  const htmlUrl = pathToFileURL(htmlPath).href;
  const timeoutMs = Number(serviceConfig.pdf?.renderTimeoutMs) > 0
    ? Number(serviceConfig.pdf.renderTimeoutMs)
    : DEFAULT_RENDER_TIMEOUT_MS;
  const candidates = chromeCandidates(serviceConfig);
  const errors = [];

  for (const executable of candidates) {
    try {
      await runProcess({
        executable,
        args: [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--allow-file-access-from-files',
          '--no-pdf-header-footer',
          '--print-to-pdf-no-header',
          `--print-to-pdf=${outputPath}`,
          htmlUrl,
        ],
        timeoutMs,
        label: 'Chrome PDF renderer',
      });
      return;
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
      if (error.code === 'ENOENT') {
        continue;
      }
      try {
        await runProcess({
          executable,
          args: [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--allow-file-access-from-files',
            '--no-pdf-header-footer',
            '--print-to-pdf-no-header',
            `--print-to-pdf=${outputPath}`,
            htmlUrl,
          ],
          timeoutMs,
          label: 'Chrome PDF renderer',
        });
        return;
      } catch (fallbackError) {
        errors.push(`${executable} legacy-headless: ${fallbackError.message}`);
      }
    }
  }

  throw new Error(`Chrome PDF renderer unavailable. Tried: ${errors.join(' | ') || 'no candidates'}`);
}

async function buildReportHtml(data) {
  let html = await fsp.readFile(REPORT_TEMPLATE, 'utf8');
  for (const [key, value] of Object.entries(data)) {
    html = html.replaceAll(`{{${key}}}`, value == null ? '' : String(value));
  }

  const logoUri = await logoDataUri();
  if (logoUri) {
    html = html.replace(/<img\s+class="banner-logo"[^>]*>/g, `<img class="banner-logo" src="${logoUri}">`);
  }

  for (const section of ['MACRO', 'COMPANY', 'ANALYST']) {
    if (!data[`HAS_${section}`]) {
      html = html.replace(new RegExp(`<!-- IF_${section} -->[\\s\\S]*?<!-- /IF_${section} -->`, 'g'), '');
    }
  }

  const templateBase = pathToFileURL(path.join(REPORT_ASSETS_DIR, 'templates', path.sep)).href;
  html = html.replace('<head>', `<head>\n<base href="${templateBase}">`);
  html = html.replace(
    '</head>',
    '<style>@media print { .banner { margin: 0 0 12pt 0 !important; width: 100% !important; } .page-break { break-after: page !important; page-break-after: always !important; height: 1px !important; display: block !important; } }</style>\n</head>',
  );
  return html.replace(/{{[A-Z0-9_]+}}/g, 'N/A');
}

async function logoDataUri() {
  try {
    const logo = await fsp.readFile(REPORT_LOGO);
    return `data:image/png;base64,${logo.toString('base64')}`;
  } catch {
    return '';
  }
}

function chromeCandidates(serviceConfig = {}) {
  const configured = [
    serviceConfig.pdf?.chromePath,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean);
  const platformCandidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        'chrome',
        'msedge',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          'google-chrome',
          'chromium',
        ]
      : [
          'google-chrome',
          'google-chrome-stable',
          'chromium',
          'chromium-browser',
        ];
  return unique([...configured, ...platformCandidates].filter(Boolean));
}

function runProcess({ executable, args, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      reject(new Error(`${label} exited with code ${code}${details ? `: ${details}` : ''}`));
    });
  });
}

function normalizeLegs(rawLegs = []) {
  if (!Array.isArray(rawLegs)) return [];
  return rawLegs.map((leg) => {
    const action = normalizeAction(leg.action ?? leg.side);
    const type = normalizeType(leg.type);
    const strike = firstFiniteNumber(leg.strike);
    const bid = firstFiniteNumber(leg.bid, leg.bestBid);
    const ask = firstFiniteNumber(leg.ask, leg.bestAsk);
    const premium = firstFiniteNumber(leg.premium, leg.mid, leg.mark, bid != null && ask != null ? (bid + ask) / 2 : null);
    return {
      ...plainObject(leg),
      action,
      type,
      strike,
      bid,
      ask,
      premium,
      quantity: firstFiniteNumber(leg.quantity) ?? 1,
      delta: firstFiniteNumber(leg.delta),
      gamma: firstFiniteNumber(leg.gamma),
      theta: firstFiniteNumber(leg.theta),
      vega: firstFiniteNumber(leg.vega),
      iv: firstFiniteNumber(leg.iv, leg.impliedVolatility),
      volume: firstFiniteNumber(leg.volume, leg.trades),
      openInterest: firstFiniteNumber(leg.openInterest, leg.oi, leg.open_interest, leg.totalOI),
    };
  }).filter((leg) => leg.type && leg.action && Number.isFinite(leg.strike));
}

function assignLegRoles(legs) {
  const puts = legs.filter((leg) => leg.type === 'PUT').sort((left, right) => left.strike - right.strike);
  const calls = legs.filter((leg) => leg.type === 'CALL').sort((left, right) => left.strike - right.strike);
  return {
    longPut: puts.find((leg) => leg.action === 'BUY') ?? puts[0] ?? null,
    shortPut: puts.find((leg) => leg.action === 'SELL') ?? puts[1] ?? null,
    shortCall: calls.find((leg) => leg.action === 'SELL') ?? calls[0] ?? null,
    longCall: calls.find((leg) => leg.action === 'BUY') ?? calls[calls.length - 1] ?? null,
  };
}

function normalizeAction(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['buy', 'long', 'bto'].includes(normalized)) return 'BUY';
  if (['sell', 'short', 'sto'].includes(normalized)) return 'SELL';
  return null;
}

function normalizeType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'put' || normalized === 'p') return 'PUT';
  if (normalized === 'call' || normalized === 'c') return 'CALL';
  return null;
}

function normalizeGammaContext(value) {
  const source = plainObject(value);
  const analysis = plainObject(source.analysis);
  return {
    ...analysis,
    ...source,
    walls: Array.isArray(source.walls) ? source.walls : Array.isArray(analysis.walls) ? analysis.walls : [],
    oiByStrike: Array.isArray(source.oiByStrike) ? source.oiByStrike : Array.isArray(analysis.oiByStrike) ? analysis.oiByStrike : [],
  };
}

function buildTradeConfig({ symbol, strategyName, expiry, roles, legs }) {
  const roleDescriptions = [
    legPhrase(roles.longPut),
    legPhrase(roles.shortPut),
    legPhrase(roles.shortCall),
    legPhrase(roles.longCall),
  ].filter(Boolean);
  const descriptions = roleDescriptions.length > 0
    ? roleDescriptions
    : legs.map(legPhrase).filter(Boolean);
  return [
    `${symbol} ${strategyName}`,
    descriptions.length > 0 ? descriptions.join(' / ') : 'leg pricing pending',
    expiry ? `Exp. ${expiry}` : '',
  ].filter(Boolean).join(' - ');
}

function legPhrase(leg) {
  if (!leg) return '';
  const action = leg.action === 'BUY' ? 'Buy' : 'Sell';
  return `${action} ${formatStrike(leg.strike) || leg.strike}${leg.type ? leg.type[0] : ''}`;
}

function splitInsightPoints(...values) {
  const text = values.map((value) => String(value ?? '').trim()).filter(Boolean).join(' ');
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?:\.\s+|;\s+|\n+| - )/)
    .map((part) => part.replace(/^[*-]\s*/, '').trim())
    .filter((part) => part.length > 12);
  return unique(parts).slice(0, 5);
}

function buildRationalePoints({ item, advisor, roles, putWall, callWall, maxLoss, oddsOfProfit }) {
  const points = splitInsightPoints(advisor.rationale, item.thesis);
  if (roles.shortPut?.strike && putWall) {
    points.push(`Short put at ${formatStrike(roles.shortPut.strike)} is measured against put-wall support near ${formatStrike(putWall)}.`);
  }
  if (roles.shortCall?.strike && callWall) {
    points.push(`Short call at ${formatStrike(roles.shortCall.strike)} is measured against call-wall resistance near ${formatStrike(callWall)}.`);
  }
  if (oddsOfProfit != null) {
    points.push(`${Math.round(oddsOfProfit)}% model-estimated probability, subject to price and volatility changes before entry.`);
  }
  if (maxLoss != null) {
    points.push(`Defined-risk structure caps model-estimated max loss at ${formatMoney(maxLoss, { compact: true })} per contract.`);
  }
  return unique(points).slice(0, 6);
}

function buildGammaMacroText({ symbol, putWall, callWall, gammaContext }) {
  if (putWall || callWall) {
    return `${symbol} gamma context shows put-wall support near ${formatStrike(putWall) || 'N/A'} and call-wall resistance near ${formatStrike(callWall) || 'N/A'}. The setup should be rechecked if spot moves through either wall.`;
  }
  if (gammaContext.source) {
    return `Gamma context was sourced from ${gammaContext.source}, but no dominant wall levels were attached to this pick.`;
  }
  return 'Gamma-wall data was not attached to this pick; validate support and resistance before publishing.';
}

function buildVolatilityMacroText({ currentIv, dte, netCredit, netDebit }) {
  const priceText = netCredit != null
    ? `${formatMoney(netCredit, { digits: 2 })} credit`
    : netDebit != null
      ? `${formatMoney(netDebit, { digits: 2 })} debit`
      : 'pricing pending';
  return `Current IV is ${formatVolatility(currentIv)} with ${dte ?? 'N/A'} days to expiry and ${priceText}. Validate live spreads because option pricing can change quickly.`;
}

function buildCompanyNewsPoints({ item, lifecycle, advisor }) {
  const news = [
    ...arrayText(lifecycle.company?.news),
    ...arrayText(lifecycle.news),
    ...arrayText(item.news),
  ];
  if (news.length > 0) return news.slice(0, 5);
  return [
    firstText(advisor.marketRead, item.thesis, 'Company-specific news was not attached to this generated pick.'),
    'Confirm earnings date, headline risk, and sector catalysts before entry.',
    'Use this report as an educational planning document, not a guaranteed outcome.',
  ];
}

function buildHeadwindPoints({ item, currentPrice, roles, maxLoss }) {
  const points = [
    ...arrayText(item.headwinds),
    item.riskNotes,
    roles.shortCall?.strike && currentPrice != null
      ? `Upside move toward ${formatStrike(roles.shortCall.strike)} can pressure the call side.`
      : null,
    maxLoss != null ? `Defined max loss remains ${formatMoney(maxLoss, { compact: true })} per contract before commissions.` : null,
  ].filter(Boolean);
  return unique(points).slice(0, 5);
}

function buildTailwindPoints({ item, advisor, putWall, callWall, dte }) {
  const points = [
    ...arrayText(item.tailwinds),
    item.thesis,
    advisor.marketRead,
    putWall && callWall ? `Dealer wall band spans ${formatStrike(putWall)} to ${formatStrike(callWall)}.` : null,
    dte ? `${dte} DTE keeps theta decay relevant while still requiring gamma discipline.` : null,
  ].filter(Boolean);
  return splitInsightPoints(...points).slice(0, 5);
}

function buildPriceJourneyRows({ currentPrice, putWall, callWall, lowBreakeven, highBreakeven }) {
  const rows = [
    ['Lower break-even', lowBreakeven],
    ['Put wall / support', putWall],
    ['Current price', currentPrice],
    ['Call wall / resistance', callWall],
    ['Upper break-even', highBreakeven],
  ].filter(([, value]) => value != null);
  return tableRows(rows.map(([label, value]) => [label, formatMoney(value, { digits: 2 })]));
}

function buildSupportResistanceRows({ roles, currentPrice, putWall, callWall, lowBreakeven, highBreakeven }) {
  const levels = [
    { price: roles.longPut?.strike, label: 'Long put hedge' },
    { price: lowBreakeven, label: 'Lower break-even' },
    { price: roles.shortPut?.strike, label: 'Short put risk boundary' },
    { price: putWall, label: 'Put gamma wall / support' },
    { price: currentPrice, label: 'Current reference price' },
    { price: callWall, label: 'Call gamma wall / resistance' },
    { price: roles.shortCall?.strike, label: 'Short call risk boundary' },
    { price: highBreakeven, label: 'Upper break-even' },
    { price: roles.longCall?.strike, label: 'Long call hedge' },
  ].filter((level) => Number.isFinite(Number(level.price)));
  const seen = new Set();
  const uniqueLevels = levels
    .sort((left, right) => Number(left.price) - Number(right.price))
    .filter((level) => {
      const key = Number(level.price).toFixed(2);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return tableRows(uniqueLevels.map((level) => [formatStrike(level.price), level.label]));
}

function buildGammaExplanation({ symbol, putWall, callWall, gammaContext }) {
  if (putWall || callWall) {
    return `Gamma walls are strike zones with concentrated open interest where dealer hedging may act as support or resistance. For ${symbol}, the current model marks ${formatStrike(putWall) || 'N/A'} as put-wall support and ${formatStrike(callWall) || 'N/A'} as call-wall resistance. The trade thesis depends on spot respecting that band; a break through either side requires review.`;
  }
  return gammaContext.source
    ? `Gamma context from ${gammaContext.source} did not provide dominant wall levels. Use the strike ladder and live open interest before entry.`
    : 'Gamma-wall context was not available for this generated pick. Validate strike positioning before publishing.';
}

function buildGammaAlignmentPoints({ roles, currentPrice, putWall, callWall }) {
  return [
    roles.shortPut?.strike ? `Short put ${formatStrike(roles.shortPut.strike)} defines the lower income side of the position.` : null,
    roles.shortCall?.strike ? `Short call ${formatStrike(roles.shortCall.strike)} defines the upper income side of the position.` : null,
    putWall ? `Put wall near ${formatStrike(putWall)} is the primary downside support check.` : null,
    callWall ? `Call wall near ${formatStrike(callWall)} is the primary upside resistance check.` : null,
    currentPrice != null ? `Current price ${formatMoney(currentPrice, { digits: 2 })} should remain inside the planned profit zone after live validation.` : null,
  ].filter(Boolean);
}

function buildGammaChartSvg({ gammaContext, roles, currentPrice, putWall, callWall }) {
  const rawRows = Array.isArray(gammaContext.oiByStrike) && gammaContext.oiByStrike.length > 0
    ? gammaContext.oiByStrike
    : Array.isArray(gammaContext.walls) && gammaContext.walls.length > 0
      ? gammaContext.walls
      : fallbackGammaRows({ roles, currentPrice, putWall, callWall });
  const rows = rawRows
    .map((row) => ({
      strike: firstFiniteNumber(row.strike, row.price),
      oi: firstFiniteNumber(row.totalOI, row.totalOi, row.oi, row.callOI, row.putOI, row.strength) ?? 1,
      side: String(row.side ?? '').toLowerCase(),
    }))
    .filter((row) => Number.isFinite(row.strike))
    .sort((left, right) => left.strike - right.strike)
    .slice(0, 12);
  if (rows.length === 0) return '<svg viewBox="0 0 568 160" xmlns="http://www.w3.org/2000/svg"></svg>';

  const maxOi = Math.max(...rows.map((row) => Math.max(1, row.oi)));
  const barWidth = Math.max(18, Math.floor(500 / rows.length) - 8);
  const gap = rows.length > 1 ? (500 - (barWidth * rows.length)) / (rows.length - 1) : 0;
  const bars = rows.map((row, index) => {
    const x = 24 + index * (barWidth + gap);
    const height = Math.max(18, Math.round((row.oi / maxOi) * 96));
    const y = 132 - height;
    const isPutWall = putWall != null && Math.abs(row.strike - putWall) < 0.01;
    const isCallWall = callWall != null && Math.abs(row.strike - callWall) < 0.01;
    const isCurrent = currentPrice != null && Math.abs(row.strike - currentPrice) < Math.max(2.5, row.strike * 0.01);
    const fill = isPutWall ? '#dc2626' : isCallWall ? '#059669' : isCurrent ? '#C9A96E' : '#9CA3AF';
    const label = isPutWall ? 'PUT WALL' : isCallWall ? 'CALL WALL' : isCurrent ? 'CURRENT' : '';
    return [
      `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(height)}" fill="${fill}" rx="2"/>`,
      `<text x="${round(x + barWidth / 2)}" y="${round(y - 6)}" text-anchor="middle" font-size="7" fill="${fill}" font-weight="700">${safeHtml(Math.round(row.oi))}</text>`,
      `<text x="${round(x + barWidth / 2)}" y="146" text-anchor="middle" font-size="6.5" fill="${fill}" font-weight="700">${safeHtml(formatStrike(row.strike))}</text>`,
      label ? `<text x="${round(x + barWidth / 2)}" y="156" text-anchor="middle" font-size="5.5" fill="${fill}">${label}</text>` : '',
    ].join('');
  }).join('');
  return `<svg viewBox="0 0 568 160" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:130pt;"><line x1="15" y1="132" x2="553" y2="132" stroke="#E6E8EB" stroke-width="0.5"/>${bars}</svg>`;
}

function fallbackGammaRows({ roles, currentPrice, putWall, callWall }) {
  return [
    roles.longPut?.strike,
    roles.shortPut?.strike,
    putWall,
    currentPrice,
    callWall,
    roles.shortCall?.strike,
    roles.longCall?.strike,
  ].filter((value) => value != null).map((strike, index) => ({
    strike,
    totalOI: 100 + index * 35,
  }));
}

function buildExecutionRows(legs) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return tableRows([['Pricing pending', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']]);
  }
  return tableRows(legs.map((leg) => {
    const spread = leg.bid != null && leg.ask != null ? Math.max(0, leg.ask - leg.bid) : null;
    return [
      `${leg.action === 'BUY' ? 'Long' : 'Short'} ${titleCase(leg.type)}`,
      formatStrike(leg.strike),
      leg.bid != null && leg.ask != null ? `${formatMoney(leg.bid, { digits: 2 })} x ${formatMoney(leg.ask, { digits: 2 })}` : 'N/A',
      formatMoney(leg.premium, { digits: 2 }) || 'N/A',
      formatMoney(leg.premium, { digits: 2 }) || 'N/A',
      spread != null ? `${formatMoney(spread, { digits: 2 })}` : 'N/A',
      leg.openInterest ?? 'N/A',
      leg.volume ?? 'N/A',
    ];
  }));
}

function estimatedSlippage(legs) {
  const spreads = legs
    .map((leg) => leg.bid != null && leg.ask != null ? Math.max(0, leg.ask - leg.bid) : null)
    .filter(Number.isFinite);
  if (spreads.length === 0) return 'Live spread check required';
  return `${formatMoney(average(spreads), { digits: 2 })} avg per leg`;
}

function buildMovingAverageSegment(indicators) {
  const sma50 = firstFiniteNumber(indicators.sma50, indicators.sma_50);
  return sma50 != null ? ` | 50 SMA: ${formatMoney(sma50, { digits: 2 })}` : '';
}

function buildThetaExplanation({ greeks, dte }) {
  const theta = firstFiniteNumber(greeks.netTheta, greeks.theta);
  if (theta == null) {
    return 'Theta could not be calculated from the supplied legs; validate live Greeks before entry.';
  }
  const daily = Math.abs(theta * 100);
  return `Position theta is model-estimated near ${formatMoney(daily, { digits: 2 })}/day per contract. With ${dte ?? 'N/A'} DTE, time decay may help the position but gamma risk rises as expiration approaches.`;
}

function buildVegaExplanation({ greeks, currentIv }) {
  const vega = firstFiniteNumber(greeks.netVega, greeks.vega);
  if (vega == null) {
    return 'Vega could not be calculated from the supplied legs; validate live volatility exposure before entry.';
  }
  const direction = vega < 0 ? 'benefits when implied volatility contracts' : 'benefits when implied volatility expands';
  return `Net vega is model-estimated at ${formatVega(vega)} with current IV ${formatVolatility(currentIv)}. The position ${direction}, all else equal.`;
}

function buildEventRiskRows({ expiry, symbol }) {
  return tableRows([
    ['Before entry', `${symbol} news and earnings check`, 'REQUIRED', 'Confirm no material event conflicts with the holding period'],
    ['Weekly', 'Macro and sector events', 'MONITOR', 'Recheck volatility and price gaps before adding size'],
    [expiry || 'Expiration', 'Option expiration', 'PLANNED', 'Close or actively manage before expiration risk dominates'],
  ]);
}

function buildThetaScheduleRows({ dte, greeks }) {
  const theta = Math.abs(firstFiniteNumber(greeks.netTheta, greeks.theta) ?? 0) * 100;
  const daily = theta > 0 ? theta : null;
  return tableRows([
    ['Entry to mid-cycle', dte ? `${Math.max(1, Math.floor(dte / 2))}` : 'N/A', daily ? formatMoney(daily, { digits: 2 }) : 'Model pending', 'Gradual'],
    ['Final 10 DTE', '10', daily ? formatMoney(daily * 1.3, { digits: 2 }) : 'Model pending', 'Accelerating'],
    ['Final 3 DTE', '3', daily ? formatMoney(daily * 1.8, { digits: 2 }) : 'Model pending', 'High gamma risk'],
  ]);
}

function buildProfitExitTrigger({ netCredit, maxProfit }) {
  if (netCredit != null) {
    return `Capture 50% of credit; target close near ${formatMoney(netCredit / 2, { digits: 2 })} debit`;
  }
  if (maxProfit != null) {
    return `Position reaches roughly 50% of max profit (${formatMoney(maxProfit / 2, { compact: true })})`;
  }
  return 'Position reaches planned profit target';
}

function buildStopExitTrigger({ netCredit, maxLoss, roles }) {
  if (netCredit != null) {
    return `Position value approaches roughly 2x credit received (${formatMoney(netCredit * 2, { digits: 2 })} debit)`;
  }
  if (maxLoss != null) {
    return `Loss approaches pre-defined risk budget (${formatMoney(maxLoss, { compact: true })} max loss)`;
  }
  const boundaries = [roles.shortPut?.strike, roles.shortCall?.strike].filter(Boolean).map(formatStrike).join(' / ');
  return boundaries ? `Price breaches short strike boundary: ${boundaries}` : 'Thesis invalidates or liquidity deteriorates';
}

function buildTimeExitTrigger({ expiry, dte }) {
  if (!expiry) return 'Exit before expiration-week gamma risk';
  const exitDate = addDays(expiry, -2);
  return `2 days before expiration (${formatLongDate(exitDate) || exitDate}) regardless of P&L${dte ? `; ${dte} DTE at report time` : ''}`;
}

function buildCapitalRows({ maxLoss }) {
  const portfolios = [10000, 25000, 50000, 100000];
  return portfolios.map((portfolio, index) => {
    const riskBudget = portfolio * 0.02;
    const contracts = maxLoss ? Math.floor(riskBudget / maxLoss) : 0;
    const klass = index === 1 ? ' class="highlight-row"' : '';
    const note = maxLoss == null
      ? 'Risk model pending'
      : contracts < 1
        ? 'Portfolio too small for this risk budget'
        : contracts === 1
          ? 'Start here; monitor closely'
          : 'Scale only after live liquidity review';
    return `<tr${klass}><td>${safeHtml(formatMoney(portfolio, { compact: true }))}</td><td>${safeHtml(formatMoney(riskBudget, { compact: true }))}</td><td>${safeHtml(contracts)}</td><td>${safeHtml(contracts > 0 ? formatMoney(maxLoss * contracts, { compact: true }) : '--')}</td><td>${safeHtml(note)}</td></tr>`;
  }).join('');
}

function buildStrategyRows({ strategyName, maxProfit, maxLoss, oddsOfProfit, margin }) {
  return [
    `<tr class="selected-row"><td>${safeHtml(strategyName)}</td><td>${safeHtml(formatMoney(maxProfit, { compact: true }) || 'Model pending')}</td><td>${safeHtml(formatMoney(maxLoss, { compact: true }) || 'Model pending')}</td><td>${safeHtml(oddsOfProfit == null ? 'N/A' : `${Math.round(oddsOfProfit)}%`)}</td><td>${safeHtml(formatMoney(margin, { compact: true }) || 'Review')}</td><td class="selected-badge">&#10003; SELECTED</td></tr>`,
    `<tr><td>Alternative defined-risk spread</td><td>Varies</td><td>Defined</td><td>Varies</td><td>Lower/Similar</td><td>Review if thesis changes</td></tr>`,
    `<tr><td>Undefined-risk short premium</td><td>Higher</td><td>Unlimited</td><td>Varies</td><td>High margin</td><td class="avoid-badge">&#10007; AVOID</td></tr>`,
  ].join('');
}

function buildAlternativeStrategyRows({ maxLoss }) {
  return tableRows([
    ['Put credit spread', 'Lower', formatMoney(maxLoss, { compact: true }) || 'Defined', 'Directional', formatMoney(maxLoss, { compact: true }) || 'Review', 'If bullish only'],
  ]);
}

function buildScoreInterpretation({ tradeScore, strategyName }) {
  const threshold = tradeScore >= 70 ? 'above' : tradeScore >= 60 ? 'at' : 'below';
  return `This ${strategyName} scores ${tradeScore}/100, ${threshold} the 60+ preferred review threshold. Treat the score as model-estimated and revalidate live pricing before publication.`;
}

function buildScoreFactors({ tradeScore, advisor, gammaContext, currentIv, maxLoss }) {
  return [
    advisor.rationale ? `Advisor rationale: ${advisor.rationale}` : null,
    gammaContext.source ? `Gamma/OI source: ${gammaContext.source}.` : 'Gamma/OI source was not attached.',
    currentIv != null ? `Current IV input: ${formatVolatility(currentIv)}.` : 'Current IV input was not available.',
    maxLoss != null ? `Defined-risk check passed with max loss ${formatMoney(maxLoss, { compact: true })}.` : 'Max-loss model is pending admin review.',
    `Confidence score: ${tradeScore}/100.`,
  ].filter(Boolean);
}

function buildMaxPainScenario({ symbol, roles, maxLoss }) {
  const boundaries = [roles.shortPut?.strike, roles.shortCall?.strike].filter(Boolean).map(formatStrike).join(' or ');
  return boundaries
    ? `${symbol} moves through ${boundaries}, pressuring one side of the spread. The model-estimated max loss is ${formatMoney(maxLoss, { compact: true }) || 'pending'} per contract before commissions and slippage.`
    : `${symbol} moves sharply against the planned spread before an exit can be executed. Max-loss modeling should be reviewed before publication.`;
}

function buildStrikeSelectionReason({ roles, putWall, callWall }) {
  const points = [
    roles.shortPut?.strike ? `short put ${formatStrike(roles.shortPut.strike)}` : null,
    roles.shortCall?.strike ? `short call ${formatStrike(roles.shortCall.strike)}` : null,
    putWall ? `put wall ${formatStrike(putWall)}` : null,
    callWall ? `call wall ${formatStrike(callWall)}` : null,
  ].filter(Boolean);
  return points.length > 0
    ? `Selected strikes are compared against ${points.join(', ')} to keep risk defined and centered around the current thesis.`
    : 'Strike selection requires live option-chain review before publication.';
}

function buildExpiryReason({ expiry, dte }) {
  return expiry
    ? `${formatLongDate(expiry) || expiry} gives ${dte ?? 'N/A'} DTE, balancing premium capture with manageable expiration risk.`
    : 'Expiry was not attached to this pick; select an expiry before publishing.';
}

function buildAlternativesRows({ maxLoss }) {
  return tableRows([
    ['Wider defined-risk spread', 'More capital at risk; only use if liquidity and premium justify the larger exposure.'],
    ['Narrower defined-risk spread', `Lower max loss than ${formatMoney(maxLoss, { compact: true }) || 'the selected spread'} but often less credit and worse reward/risk.`],
    ['Undefined-risk short premium', 'Rejected for NewLeaf publication because downside is not capped.'],
  ]);
}

function buildTradeSpecRows({
  symbol,
  companyName,
  strategyName,
  expiry,
  dte,
  roles,
  netCredit,
  netDebit,
  maxProfit,
  maxLoss,
  lowBreakeven,
  highBreakeven,
}) {
  const rows = [
    ['Strategy', `${strategyName}`],
    ['Underlying', `${symbol}${companyName && companyName !== symbol ? ` - ${companyName}` : ''}`],
    ['Expiration', expiry ? `${formatLongDate(expiry) || expiry}${dte ? ` (${dte} DTE at entry)` : ''}` : 'Review required'],
    ['Put Spread', roles.longPut || roles.shortPut ? `${legPhrase(roles.longPut) || 'Long put pending'} / ${legPhrase(roles.shortPut) || 'Short put pending'}` : 'N/A'],
    ['Call Spread', roles.shortCall || roles.longCall ? `${legPhrase(roles.shortCall) || 'Short call pending'} / ${legPhrase(roles.longCall) || 'Long call pending'}` : 'N/A'],
    ['Net Pricing', formatMidMarketPrice({ netCredit, netDebit })],
    ['Max Profit', formatMoney(maxProfit, { compact: true }) || 'Model pending'],
    ['Max Loss', formatMoney(maxLoss, { compact: true }) || 'Model pending'],
    ['Break-Even Low', formatStrike(lowBreakeven) || 'N/A'],
    ['Break-Even High', formatStrike(highBreakeven) || 'N/A'],
  ];
  return tableRows(rows);
}

function analystDataAvailable(item, lifecycle) {
  return Boolean(item.analyst || lifecycle.analyst);
}

function arrayText(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    return firstText(item?.text, item?.headline, item?.summary, item?.factor);
  }).filter(Boolean);
}

function tableRows(rows) {
  return rows.map((cells) =>
    `<tr>${cells.map((cell) => `<td>${safeHtml(cell)}</td>`).join('')}</tr>`).join('');
}

function listItems(items) {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  return normalized.length > 0
    ? normalized.map((item) => `<li>${safeHtml(item)}</li>`).join('')
    : '<li>Review live market context before publication.</li>';
}

function firstText(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
}

function textValue(value) {
  return String(value ?? '').trim();
}

function safeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value, { digits = 2, compact = false } = {}) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '';
  const decimals = compact ? 0 : digits;
  return `$${numberValue.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatStrike(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '';
  const decimals = Number.isInteger(numberValue) ? 0 : 2;
  return `$${numberValue.toFixed(decimals)}`;
}

function formatBreakevenRange(low, high) {
  if (low != null && high != null) return `${formatStrike(low)}-${formatStrike(high)}`;
  if (low != null) return formatStrike(low);
  if (high != null) return formatStrike(high);
  return 'Model pending';
}

function formatRiskReward(value) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  if (text.includes(':')) return text;
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue)) return text;
  return `${round(numberValue, 2)}:1`;
}

function formatPriceChange(change, changePercent) {
  if (change == null && changePercent == null) return '';
  const changeText = change == null
    ? ''
    : `${change >= 0 ? '+' : '-'}${formatMoney(Math.abs(change), { digits: 2 })}`;
  const pctText = changePercent == null
    ? ''
    : `${changePercent >= 0 ? '+' : '-'}${Math.abs(changePercent).toFixed(2)}%`;
  return [changeText, pctText ? `(${pctText})` : ''].filter(Boolean).join(' ');
}

function formatVolatility(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  const percent = numberValue <= 1 ? numberValue * 100 : numberValue;
  return `${round(percent, 1)}%`;
}

function formatVolatilityNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  const percent = numberValue <= 1 ? numberValue * 100 : numberValue;
  return round(percent, 1);
}

function formatIndicator(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  return round(numberValue, 2);
}

function formatMidMarketPrice({ netCredit, netDebit }) {
  if (netCredit != null) return `${formatMoney(netCredit, { digits: 2 })} credit`;
  if (netDebit != null) return `${formatMoney(netDebit, { digits: 2 })} debit`;
  return 'Pricing pending';
}

function formatTheta(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  const cash = Math.abs(numberValue) * 100;
  return `${numberValue >= 0 ? '+' : '-'}${formatMoney(cash, { digits: 2 })}/day`;
}

function formatVega(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  return `${numberValue >= 0 ? '+' : '~'}${round(numberValue * 100, 1)}`;
}

function confidenceLabel(score) {
  if (score >= 80) return 'High Confidence';
  if (score >= 60) return 'Moderate Confidence';
  return 'Review Required';
}

function confidenceThresholdLabel(score) {
  if (score >= 70) return 'above threshold';
  if (score >= 60) return 'meets minimum threshold';
  return 'below preferred threshold';
}

function rsiSignal(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 'N/A';
  if (numberValue >= 70) return 'Overbought';
  if (numberValue <= 30) return 'Oversold';
  if (numberValue >= 55) return 'Constructive';
  if (numberValue <= 45) return 'Weak';
  return 'Neutral';
}

function rsiDescription(value) {
  const signal = rsiSignal(value);
  if (signal === 'N/A') return 'RSI was not supplied by the market analysis API.';
  return `${signal} momentum reading; use with gamma and volatility context before entry.`;
}

function movingAverageSignal(indicators) {
  return titleCase(String(indicators.smaTrend ?? indicators.maSignal ?? 'mixed').replace(/_/g, ' '));
}

function movingAverageDescription(indicators) {
  const priceVsSma = String(indicators.priceVsSma ?? '').replace(/_/g, ' ');
  return priceVsSma ? `Price is ${priceVsSma} relative to key moving averages.` : 'Moving-average alignment is used as a trend filter.';
}

function formatReportDate(value, fallback = new Date().toISOString()) {
  return formatLongDate(value) || formatLongDate(fallback) || formatLongDate(new Date().toISOString());
}

function formatReportTime(value) {
  const date = parseDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(date);
}

function formatLongDate(value) {
  const date = parseDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T12:00:00.000Z`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysToExpiry(expiry, asOf) {
  const start = parseDate(asOf);
  const end = parseDate(expiry);
  if (!start || !end) return null;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(1, Math.round((endUtc - startUtc) / 86400000));
}

function addDays(dateValue, days) {
  const date = parseDate(dateValue);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scoreFromRecommendation(item) {
  const odds = firstFiniteNumber(item.oddsOfProfit);
  const rewardRisk = firstFiniteNumber(item.rewardRisk);
  const hasDefinedRisk = firstFiniteNumber(item.maxLoss) != null;
  return clamp(55 + (odds ? (odds - 50) * 0.4 : 0) + (rewardRisk ? rewardRisk * 6 : 0) + (hasDefinedRisk ? 8 : 0), 40, 82);
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstFiniteNumber(...value);
      if (nested != null) return nested;
      continue;
    }
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function titleCase(value) {
  return String(value ?? '').toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function plainObject(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}
