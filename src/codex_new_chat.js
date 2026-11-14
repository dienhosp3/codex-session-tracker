'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const PRESETS = Object.freeze(['default', '400k', '550k', '700k', '900k', 'custom']);
const WINDOWS = { '400k': 400000, '550k':550000, '600k':600000, '700k':700000, '900k': 900000 };
function customPresetK(value){if(value==='600k')return 600;const match=/^custom:(\d+)$/.exec(String(value));return match?Number(match[1]):null;}

function formatContextK(value) {
  return Number.isFinite(value) && value > 0
    ? (value / 1000).toLocaleString('vi-VN', { useGrouping: false, maximumFractionDigits: 1 }) + 'K'
    : 'chưa rõ';
}

function normalizeContextPreset(value = 'default') {
  const custom=customPresetK(value);
  if(!PRESETS.includes(value)&&!(Number.isSafeInteger(custom)&&custom>0&&Number.isSafeInteger(custom*1000)))throw new Error('Chọn context mặc định, 400K, 550K, 700K, 900K hoặc số K tự đặt.');
  return value;
}

// Read only model metadata, never authentication or conversation history.
async function readModelContext(codexHome, model, catalogFile) {
  for (const file of [catalogFile, path.join(codexHome, 'models_cache.json')].filter(Boolean)) {
    let catalog;
    try { catalog = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (file === catalogFile) throw new Error('Không đọc được model catalog: ' + error.message); continue; }
    const found = (Array.isArray(catalog) ? catalog : catalog.models || []).find(item => item.slug === model);
    if (!found) continue;
    const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    const percent = positive(found.effective_context_window_percent);
    return { model, defaultTokens: positive(found.context_window), maxTokens: positive(found.max_context_window),
      effectivePercent: percent && percent <= 100 ? percent : null };
  }
  return { model, defaultTokens: null, maxTokens: null, effectivePercent: null };
}

function contextChoice(preset, metadata) {
  normalizeContextPreset(preset);
  if(preset==='custom')return {preset,available:true,custom:true,requestedTokens:null,appliedTokens:null,effectiveTokens:null,compactTokens:null,limited:false};
  const requestedTokens = preset === 'default' ? metadata.defaultTokens : customPresetK(preset)!==null?customPresetK(preset)*1000:WINDOWS[preset];
  const appliedTokens = requestedTokens && metadata.maxTokens ? Math.min(requestedTokens, metadata.maxTokens) : requestedTokens;
  const effectiveTokens = appliedTokens && metadata.effectivePercent ? Math.floor(appliedTokens * metadata.effectivePercent / 100) : null;
  const compactTokens = effectiveTokens ? Math.floor(effectiveTokens * .9) : appliedTokens ? Math.floor(appliedTokens * .85) : null;
  return { preset, requestedTokens, appliedTokens, effectiveTokens, compactTokens,
    limited: Boolean(requestedTokens && appliedTokens < requestedTokens), available: Boolean(requestedTokens) };
}

function contextConfig(preset, metadata) {
  if(preset==='custom')throw new Error('Nhập số K nguyên dương cho context tự đặt.');
  const choice = contextChoice(preset, metadata);
  if (!choice.available) throw new Error('Chưa có metadata context mặc định của model ' + metadata.model + '. Mở Codex để cập nhật danh sách model, hoặc chọn một mức cụ thể.');
  return { model_context_window: choice.requestedTokens,
    model_auto_compact_token_limit: choice.compactTokens, model_auto_compact_token_limit_scope: 'total' };
}

function contextChoices(metadata){
 return PRESETS.map(preset=>{
  const choice=contextChoice(preset,metadata);
  return {preset,label:preset==='custom'?'Tự đặt':choice.requestedTokens?formatContextK(choice.requestedTokens):'—K',capacity:'',
   detail:preset==='custom'?'Nhập số K':(preset==='default'?'Mặc định · ':'')+(choice.effectiveTokens?'Dùng '+formatContextK(choice.effectiveTokens):'Chưa rõ'),
   requestedK:choice.requestedTokens?Math.ceil(choice.requestedTokens/1000):null,note:choice.limited?'Trần '+formatContextK(choice.appliedTokens):'',available:choice.available};
 });
}

function validateContextConfig(value) {
  if (value === undefined) return undefined;
  const { model_context_window: window, model_auto_compact_token_limit: compact, model_auto_compact_token_limit_scope: scope } = value || {};
  if (!Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(compact) || compact <= 0 || compact >= window || scope !== 'total') {
    throw new Error('Cấu hình context chat mới không hợp lệ.');
  }
  // Only these settings may cross the creation boundary; no arbitrary config.
  return { model_context_window: window, model_auto_compact_token_limit: compact, model_auto_compact_token_limit_scope: scope };
}

module.exports = { PRESETS, normalizeContextPreset, readModelContext, contextChoice, contextConfig, validateContextConfig, formatContextK,customPresetK,contextChoices };
