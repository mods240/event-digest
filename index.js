/**
 * Event Digest / 受信・正規化デーモン (Component B)
 * BUILD: 2026-07-26  (v0.2 取り消し対応)
 *
 * 役割:
 *   Realtime Database の新着投稿を検知 → Storage からダウンロード
 *   → ffmpeg で正規化 / プロキシ / サムネイル生成 → メタJSON出力
 *
 * 起動: npm start
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const admin = require('firebase-admin');

// ============================================================
// 設定読み込み
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');

function die(msg) {
  console.error('\n[FATAL] ' + msg + '\n');
  process.exit(1);
}

if (!fs.existsSync(CONFIG_PATH)) die('config.json が見つかりません。');
if (!fs.existsSync(KEY_PATH)) die('serviceAccountKey.json が見つかりません。Firebaseコンソールから取得して daemon/ 直下に置いてください。');

const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const SERVICE_ACCOUNT = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));

function expandTilde(p) {
  if (p && p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

const EVENT_ID = CFG.eventId;
const WORK_ROOT = path.join(expandTilde(CFG.workDir), EVENT_ID);
const DIRS = {
  incoming: path.join(WORK_ROOT, 'incoming'),
  normalized: path.join(WORK_ROOT, 'normalized'),
  proxy: path.join(WORK_ROOT, 'proxy'),
  thumbs: path.join(WORK_ROOT, 'thumbs'),
  meta: path.join(WORK_ROOT, 'meta'),
  removed: path.join(WORK_ROOT, 'removed'),
};
const STATE_PATH = path.join(WORK_ROOT, 'state.json');

const FFMPEG = CFG.ffmpegPath || 'ffmpeg';
const FFPROBE = CFG.ffprobePath || 'ffprobe';
const NRM = CFG.normalize || {};
const MAX_W = NRM.maxWidth || 1920;
const MAX_H = NRM.maxHeight || 1080;
const FPS = NRM.fps || 30;
const CRF = NRM.crf || 20;
const PRESET = NRM.preset || 'veryfast';
const PROXY_H = (CFG.proxy && CFG.proxy.height) || 480;
const PROXY_CRF = (CFG.proxy && CFG.proxy.crf) || 28;
const THUMB_COUNT = CFG.thumbCount || 3;
const MAX_ATTEMPTS = CFG.maxAttempts || 3;

// ============================================================
// ユーティリティ
// ============================================================
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.log(`[${ts()}] !! ${msg}`); }

function ensureDirs() {
  Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return { processed: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 外部コマンドを実行し、終了を待つ */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject(new Error(`${cmd} を実行できません: ${err.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} が異常終了 (code ${code})\n${stderr.slice(-1200)}`));
    });
  });
}

/** ffprobe で JSON を取得 */
function probe(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file];
    const p = spawn(FFPROBE, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error(`ffprobe を実行できません: ${e.message}`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 失敗: ${err.slice(-600)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function parseFps(str) {
  if (!str) return null;
  const m = String(str).split('/');
  if (m.length === 2 && Number(m[1]) !== 0) return Number(m[0]) / Number(m[1]);
  return Number(str) || null;
}

// ============================================================
// Firebase 初期化
// ============================================================
admin.initializeApp({
  credential: admin.credential.cert(SERVICE_ACCOUNT),
  databaseURL: CFG.databaseURL,
  storageBucket: CFG.storageBucket,
});
const db = admin.database();
const bucket = admin.storage().bucket();

// ============================================================
// 処理キュー
// ============================================================
const queue = [];
let running = false;
let currentId = null;              // いま処理中の素材ID
const removedIds = new Set();      // 参加者が取り消した素材ID
const state = { processed: {} };

function enqueue(item) {
  queue.push(item);
  if (!running) processQueue();
}

/**
 * 参加者が取り消した素材を removed/ へ隔離する。
 * 削除ではなく移動なので、誤操作でも復元できる。
 * meta/ から外れるため、編集アプリ(C)からは見えなくなる。
 */
function quarantine(id) {
  const dest = path.join(DIRS.removed, id);
  let moved = 0;

  const move = (from, to) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (e) {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    }
    moved++;
  };

  // incoming は拡張子が元ファイル依存なので走査する
  try {
    fs.readdirSync(DIRS.incoming)
      .filter((f) => f.startsWith(id + '.'))
      .forEach((f) => move(path.join(DIRS.incoming, f), path.join(dest, f)));
  } catch (e) { /* ディレクトリが無ければ何もしない */ }

  move(path.join(DIRS.normalized, `${id}.mp4`), path.join(dest, `${id}.mp4`));
  move(path.join(DIRS.proxy, `${id}.mp4`), path.join(dest, `${id}_proxy.mp4`));
  move(path.join(DIRS.meta, `${id}.json`), path.join(dest, `${id}.json`));

  try {
    fs.readdirSync(DIRS.thumbs)
      .filter((f) => f.startsWith(id + '_'))
      .forEach((f) => move(path.join(DIRS.thumbs, f), path.join(dest, f)));
  } catch (e) { /* 同上 */ }

  if (state.processed[id]) {
    state.processed[id].removed = true;
    saveState(state);
  }
  log(`   ↩ 取り消し処理: ${moved} ファイルを removed/ へ移動しました`);
}

async function processQueue() {
  running = true;
  while (queue.length > 0) {
    const item = queue.shift();
    if (removedIds.has(item.id)) {          // 処理前に取り消された
      log(`(取り消し済みのためスキップ) ${item.id}`);
      continue;
    }
    currentId = item.id;
    try {
      await processOne(item);
      if (removedIds.has(item.id)) {        // 処理中に取り消された
        quarantine(item.id);
        removedIds.delete(item.id);
      }
    } catch (err) {
      item.attempt = (item.attempt || 1) + 1;
      if (item.attempt <= MAX_ATTEMPTS) {
        warn(`${item.id} 失敗 (${item.attempt - 1}/${MAX_ATTEMPTS}) → 10秒後に再試行\n    ${err.message}`);
        await sleep(10000);
        queue.push(item);
      } else {
        warn(`${item.id} 最終失敗。スキップします。\n    ${err.message}`);
        await db.ref(`events/${EVENT_ID}/uploads/${item.id}`).update({
          status: 'error',
          error: String(err.message).slice(0, 500),
        }).catch(() => {});
      }
    }
  }
  currentId = null;
  running = false;
  log(`待機中 … (処理済み ${Object.keys(state.processed).length} 件)`);
}

// ============================================================
// 1件の処理
// ============================================================
async function processOne(item) {
  const id = item.id;
  const data = item.data || {};
  const nickname = data.nickname || '(名無し)';
  const storagePath = data.storagePath;

  if (!storagePath) throw new Error('storagePath がありません');

  log(`── ${id} / ${nickname} / ${data.fileName || path.basename(storagePath)}`);

  const dbRef = db.ref(`events/${EVENT_ID}/uploads/${id}`);
  await dbRef.update({ status: 'processing' }).catch(() => {});

  // --- 1. ダウンロード ---
  const ext = path.extname(storagePath) || '.mov';
  const rawPath = path.join(DIRS.incoming, `${id}${ext}`);
  if (!fs.existsSync(rawPath)) {
    log('   ダウンロード中 …');
    await bucket.file(storagePath).download({ destination: rawPath });
  }
  const rawSize = fs.statSync(rawPath).size;
  if (rawSize < 1024) throw new Error('ダウンロードしたファイルが小さすぎます(破損の可能性)');

  // --- 2. 元素材を解析 ---
  const info = await probe(rawPath);
  const vs = (info.streams || []).find((s) => s.codec_type === 'video');
  const as = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!vs) throw new Error('映像ストリームがありません');

  const duration = Number((info.format && info.format.duration) || vs.duration || 0);
  const hasAudio = !!as;

  // --- 3. 正規化 ---
  // アスペクト比は変えず、1920x1080 の枠に収まるよう縮小のみ(拡大しない)。
  // 縦素材は縦のまま維持し、ブラー背景合成は編集側(C)で行う。
  const normPath = path.join(DIRS.normalized, `${id}.mp4`);
  const vf = [
    `scale='min(iw,${MAX_W})':'min(ih,${MAX_H})':force_original_aspect_ratio=decrease`,
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    `fps=${FPS}`,
  ].join(',');

  const normArgs = ['-y', '-i', rawPath];
  if (!hasAudio) {
    // 音声が無い素材にも無音トラックを付け、後段の連結を安全にする
    normArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  normArgs.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'
  );
  if (!hasAudio) normArgs.push('-shortest');
  normArgs.push(normPath);

  log('   正規化中 …');
  await run(FFMPEG, normArgs);

  // --- 4. プロキシ(プレビュー用・軽量) ---
  const proxyPath = path.join(DIRS.proxy, `${id}.mp4`);
  log('   プロキシ生成中 …');
  await run(FFMPEG, [
    '-y', '-i', normPath,
    '-vf', `scale='trunc(iw*${PROXY_H}/ih/2)*2':${PROXY_H}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(PROXY_CRF),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '96k',
    proxyPath,
  ]);

  // --- 5. サムネイル ---
  const normInfo = await probe(normPath);
  const nvs = (normInfo.streams || []).find((s) => s.codec_type === 'video');
  const normDuration = Number((normInfo.format && normInfo.format.duration) || 0);
  const thumbs = [];
  for (let i = 0; i < THUMB_COUNT; i++) {
    const ratio = (i + 1) / (THUMB_COUNT + 1);
    const t = Math.max(0, normDuration * ratio);
    const tp = path.join(DIRS.thumbs, `${id}_${i + 1}.jpg`);
    await run(FFMPEG, [
      '-y', '-ss', t.toFixed(2), '-i', normPath,
      '-frames:v', '1', '-q:v', '3',
      '-vf', 'scale=640:-2',
      tp,
    ]);
    thumbs.push({ index: i + 1, timeSec: Number(t.toFixed(2)), path: tp });
  }

  // --- 6. メタデータ出力 ---
  const width = Number(nvs.width);
  const height = Number(nvs.height);
  const meta = {
    id,
    eventId: EVENT_ID,
    nickname,
    originalFileName: data.fileName || path.basename(storagePath),
    uploadedAt: data.uploadedAt || null,
    processedAt: new Date().toISOString(),
    source: {
      storagePath,
      bytes: rawSize,
      codec: vs.codec_name,
      width: Number(vs.width),
      height: Number(vs.height),
      fps: parseFps(vs.r_frame_rate),
      hasAudio,
      durationSec: Number(duration.toFixed(3)),
      createdAt: (info.format && info.format.tags && (info.format.tags.creation_time || null)) || null,
    },
    normalized: {
      path: normPath,
      proxyPath,
      width,
      height,
      fps: FPS,
      durationSec: Number(normDuration.toFixed(3)),
      orientation: width >= height ? 'landscape' : 'portrait',
      aspect: Number((width / height).toFixed(4)),
      bytes: fs.statSync(normPath).size,
    },
    thumbs,
    // 素材評価(C の Claude API スコアリングで書き込む枠)
    score: null,
    tags: [],
  };
  const metaPath = path.join(DIRS.meta, `${id}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  // --- 7. 完了記録 ---
  await dbRef.update({
    status: 'done',
    processedAt: admin.database.ServerValue.TIMESTAMP,
    durationSec: meta.normalized.durationSec,
    orientation: meta.normalized.orientation,
  }).catch(() => {});

  state.processed[id] = { at: new Date().toISOString(), nickname };
  saveState(state);

  log(`   ✓ 完了  ${meta.normalized.width}x${meta.normalized.height} / ${meta.normalized.durationSec}s / ${meta.normalized.orientation}`);
}

// ============================================================
// メイン
// ============================================================
function main() {
  ensureDirs();
  const loaded = loadState();
  Object.assign(state.processed, loaded.processed || {});

  console.log('==============================================');
  console.log('  Event Digest / 受信デーモン  BUILD 2026-07-26 (v0.2)');
  console.log('==============================================');
  log(`イベントID : ${EVENT_ID}`);
  log(`作業フォルダ: ${WORK_ROOT}`);
  log(`処理済み   : ${Object.keys(state.processed).length} 件(再処理しません)`);
  log('新着を監視します。停止は Ctrl+C。');
  console.log('----------------------------------------------');

  const ref = db.ref(`events/${EVENT_ID}/uploads`);

  ref.on('child_added', (snap) => {
    const id = snap.key;
    if (state.processed[id]) return;              // 既に処理済み
    if (queue.some((q) => q.id === id)) return;   // 既にキュー内
    enqueue({ id, data: snap.val(), attempt: 1 });
  });

  ref.on('child_removed', (snap) => {
    const id = snap.key;
    log(`(取り消し検知) ${id}`);
    removedIds.add(id);

    // キュー待ちなら、そのまま捨てる
    const qi = queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      queue.splice(qi, 1);
      removedIds.delete(id);
      log('   キューから除外しました');
      return;
    }
    // 処理中なら、完了後に processQueue 側で隔離する
    if (currentId === id) {
      log('   処理中のため、完了後に隔離します');
      return;
    }
    // 処理済みなら、すぐ隔離
    quarantine(id);
    removedIds.delete(id);
  });

  process.on('SIGINT', () => {
    console.log('\n停止します。');
    saveState(state);
    process.exit(0);
  });
}

main();
