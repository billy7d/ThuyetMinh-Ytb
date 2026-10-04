import { describe, expect, it } from 'vitest';
import {
  RealtimePipeline,
  STTProvider,
  STTStreamSession,
  TTSProvider,
  TTSRequest,
  TTSResponse,
  TranslationEngine,
  TranslationProvider
} from '@vietdub/backend';
import { CaptionWord, ScriptSegment, ServerMessage, ScriptSentencesMessage, SubtitleEventMessage, TTSChunkMessage } from '@vietdub/shared';
import { buildCaptionScript, chunkCaptionWords, parseAsrWords, segmentSlotMs } from '../../extension/src/captions/caption-script.js';
import { youtubeVideoId } from '../../extension/src/captions/caption-messages.js';
import { ScriptDubPlayer } from '../../extension/src/captions/script-player.js';

const SAMPLE_RATE = 48_000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function json3(events: Array<[number, number, string]>) {
  return { events: [{ tStartMs: 0, dDurationMs: 100 }, ...events.map(([tStartMs, dDurationMs, utf8]) => ({ tStartMs, dDurationMs, segs: [{ utf8 }] }))] };
}

describe('phụ đề YouTube -> câu', () => {
  it('ghép dòng thành câu theo dấu câu, bỏ (Laughter), một dòng hai câu thì chia mốc theo số ký tự', () => {
    const segments = buildCaptionScript(json3([
      [1_000, 2_000, 'There have been three themes\nrunning through the conference,'],
      [3_000, 2_000, 'which are relevant to my talk.'],
      [5_000, 1_000, '(Laughter)'],
      [6_000, 2_000, 'Good. It has been great.']
    ]));
    expect(segments.map(segment => segment.text)).toEqual([
      'There have been three themes running through the conference, which are relevant to my talk.',
      'Good.',
      'It has been great.'
    ]);
    expect(segments[0]).toMatchObject({ startMs: 1_000, endMs: 5_000 });
    expect(segments[1].startMs).toBe(6_000);
    expect(segments[1].endMs).toBeGreaterThan(6_000);
    expect(segments[1].endMs).toBeLessThan(7_000);
    expect(segments[2].endMs).toBe(8_000);
    expect(new Set(segments.map(segment => segment.segmentId)).size).toBe(3);
  });

  it('không tách ở chữ viết tắt; dòng chưa có dấu chấm nhưng cách dòng sau quá 2 s thì thành câu riêng', () => {
    const segments = buildCaptionScript(json3([
      [0, 2_000, 'Mr. Smith went to the U.S. office'],
      [5_000, 2_000, 'and then he left.']
    ]));
    expect(segments.map(segment => segment.text)).toEqual(['Mr. Smith went to the U.S. office', 'and then he left.']);
  });

  it('khung giọng đọc của câu kéo tới ngay trước câu kế tiếp; mã video lấy từ watch/shorts', () => {
    const segments: ScriptSegment[] = [
      { segmentId: 'a', text: 'A.', startMs: 1_000, endMs: 2_000 },
      { segmentId: 'b', text: 'B.', startMs: 4_000, endMs: 5_000 }
    ];
    expect(segmentSlotMs(segments, 0)).toBe(2_900);
    expect(segmentSlotMs(segments, 1)).toBe(2_500);
    expect(youtubeVideoId('https://www.youtube.com/watch?v=iG9CE55wbtY&t=10')).toBe('iG9CE55wbtY');
    expect(youtubeVideoId('https://m.youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://example.com/watch?v=x')).toBeNull();
  });
});

function voicedBuffer(seconds: number): AudioBuffer {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < data.length; index += 1) data[index] = 0.3 * Math.sin((2 * Math.PI * 140 * index) / SAMPLE_RATE);
  return makeBuffer(data);
}

function makeBuffer(data: Float32Array): AudioBuffer {
  return {
    duration: data.length / SAMPLE_RATE,
    length: data.length,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => data,
    copyToChannel: (source: Float32Array) => data.set(source)
  } as unknown as AudioBuffer;
}

/** audioBase64 giả: số ký tự sau khi giải mã = số mili giây giọng đọc. */
function fakeAudio(ms: number): string {
  return btoa('x'.repeat(ms));
}

function setup(segments: ScriptSegment[], mode: 'dubbing_and_subtitle' | 'subtitle_only' = 'dubbing_and_subtitle') {
  const video = { currentTime: 0, paused: false, seeking: false, ended: false, playbackRate: 1 };
  const audioCtx = {
    currentTime: 100,
    createBuffer: (_channels: number, length: number) => makeBuffer(new Float32Array(length)),
    decodeAudioData: async (bytes: ArrayBuffer) => voicedBuffer(bytes.byteLength / 1000)
  };
  const scheduled: Array<{ durationSec: number; delaySec: number; offsetSec: number }> = [];
  const mixer = {
    scheduleTTSAt(buffer: AudioBuffer, delaySec: number, offsetSec: number) {
      scheduled.push({ durationSec: buffer.duration, delaySec, offsetSec });
      return { source: {} as AudioBufferSourceNode, delayMs: delaySec * 1000, durationMs: Math.round((buffer.duration - offsetSec) * 1000) };
    }
  };
  const sent: string[][] = [];
  const subtitles: Array<{ id: string; text: string }> = [];
  const player = new ScriptDubPlayer({
    video: video as unknown as HTMLVideoElement,
    audioCtx: audioCtx as unknown as BaseAudioContext,
    mixer: mixer as never,
    segments,
    getMode: () => mode,
    send: batch => sent.push(batch.map(segment => segment.segmentId)),
    showSubtitle: (segment, text) => subtitles.push({ id: segment.segmentId, text }),
    diagScope: 'test_script'
  });
  const tick = () => (player as unknown as { tick(): void }).tick();
  const tts = (segmentId: string, ms: number) => player.handleTts({
    type: 'TTS_CHUNK', sessionId: 's', timestamp: 0, segmentId, audioBase64: fakeAudio(ms), mimeType: 'audio/wav', sampleRate: SAMPLE_RATE,
    channels: 1, durationMs: ms, generation: 1, translatedText: `vi ${segmentId}`, startMs: 0, endMs: 0, scheduled: true
  });
  return { player, video, audioCtx, scheduled, sent, subtitles, tick, tts };
}

const SCRIPT: ScriptSegment[] = [
  { segmentId: 's1', text: 'One.', startMs: 1_000, endMs: 3_000 },
  { segmentId: 's2', text: 'Two.', startMs: 4_000, endMs: 6_000 },
  { segmentId: 's3', text: 'Three.', startMs: 60_000, endMs: 62_000 }
];

describe('phụ đề tự động (ASR): từ kèm mốc và chia phần gửi backend', () => {
  it('lấy từng từ với mốc = đầu dòng + tOffsetMs, theo thứ tự thời gian', () => {
    const words = parseAsrWords({ events: [
      { tStartMs: 5_000, dDurationMs: 2_000, segs: [{ utf8: 'and' }, { utf8: ' then', tOffsetMs: 400 }] },
      { tStartMs: 1_000, dDurationMs: 2_000, segs: [{ utf8: 'so' }, { utf8: ' we', tOffsetMs: 300 }] },
      { tStartMs: 3_000, segs: [{ utf8: '\n' }] }
    ] });
    expect(words).toEqual([
      { text: 'so', startMs: 1_000 }, { text: 'we', startMs: 1_300 }, { text: 'and', startMs: 5_000 }, { text: 'then', startMs: 5_400 }
    ]);
  });

  it('phần chứa vị trí đang xem đi trước, cắt ở khoảng ngừng dài nhất; phần trước vị trí đi sau cùng; không mất từ nào', () => {
    const words: CaptionWord[] = Array.from({ length: 1_000 }, (_, index) => ({ text: `w${index}`, startMs: index * 300 + (index === 640 ? 2_000 : 0) + (index > 640 ? 2_000 : 0) }));
    const chunks = chunkCaptionWords(words, 150_000, 400);
    // Vị trí 150 s ~ từ 500; lùi 15 s ~ từ 450, rồi lùi tiếp tới khoảng ngừng dài nhất trong 60 từ trước đó.
    expect(chunks[0][0].startMs).toBeLessThanOrEqual(135_000);
    expect(chunks[0][0].startMs).toBeGreaterThan(115_000);
    // Phần đầu kết thúc ngay trước khoảng ngừng 2 s (từ 640) thay vì cắt cứng ở 400 từ.
    expect(chunks[0].at(-1)?.text).toBe('w639');
    expect(chunks.at(-1)?.[0].text).toBe('w0');
    expect(chunks.flat().map(word => word.text).sort()).toEqual(words.map(word => word.text).sort());
  });
});

describe('ScriptDubPlayer: phát giọng đúng mốc câu gốc', () => {
  it('gửi trước các câu trong 45 s tới một lần; phát đúng lúc câu bắt đầu (trễ 0) kèm phụ đề', async () => {
    const { video, scheduled, sent, subtitles, tick, tts } = setup(SCRIPT);
    // Đang tạm dừng: chuẩn bị cả câu sắp bắt đầu.
    video.paused = true;
    video.currentTime = 0.7;
    tick();
    tick();
    expect(sent).toEqual([['s1', 's2']]);
    video.paused = false;
    await tts('s1', 2_000);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delaySec).toBeCloseTo(0.3, 3);
    expect(scheduled[0].offsetSec).toBe(0);
    expect(subtitles).toEqual([]);
    await wait(350);
    expect(subtitles).toEqual([{ id: 's1', text: 'vi s1' }]);
  });

  it('đang phát: câu bắt đầu quá sớm để kịp dịch + đọc thì không gửi, để các câu sau không muộn theo', () => {
    const { video, sent, tick } = setup(SCRIPT);
    // s1 (dài 2 s) cần ~2.5 s chuẩn bị nhưng chỉ còn 0.3 s; s2 bắt đầu sau 3.3 s thì kịp.
    video.currentTime = 0.7;
    tick();
    expect(sent).toEqual([['s2']]);
  });

  it('giọng dài hơn khung tới câu sau: co giãn giữ cao độ cho vừa khung (tối đa 1.3x)', async () => {
    const { video, scheduled, tick, tts } = setup(SCRIPT);
    video.currentTime = 0.9;
    tick();
    await tts('s1', 3_480);
    // Khung s1 = 4000 - 1000 - 100 = 2900 ms -> 3480/2900 = 1.2x.
    expect(scheduled[0].durationSec).toBeCloseTo(2.9, 1);
  });

  it('tiếp tục sau tạm dừng/tua vào giữa câu: đọc tiếp từ chỗ khớp video; muộn ít thì đọc lại từ đầu câu', async () => {
    const { video, scheduled, tick, tts, player } = setup(SCRIPT);
    video.paused = true;
    await tts('s1', 2_000);
    video.currentTime = 2.8;
    video.paused = false;
    tick();
    expect(scheduled[0].offsetSec).toBeCloseTo(1.8, 3);
    // Trình duyệt báo tua khi video đã ở vị trí mới.
    video.currentTime = 1.5;
    player.handleSeek();
    expect(scheduled[1].offsetSec).toBe(0);
    expect(scheduled[1].delaySec).toBe(0);
  });

  it('giọng không kịp (muộn quá 1.5 s): bỏ giọng, vẫn hiện phụ đề nếu đã có bản dịch', () => {
    const { video, player, scheduled, subtitles, tick } = setup(SCRIPT);
    player.handleSubtitle({ type: 'SUBTITLE_EVENT', sessionId: 's', timestamp: 0, segmentId: 's1', text: 'vi s1', startMs: 1_000, endMs: 3_000, generation: 1, action: 'show', scheduled: true });
    video.currentTime = 2.6;
    tick();
    expect(scheduled).toEqual([]);
    expect(subtitles.map(item => item.id)).toEqual(['s1']);
  });

  it('câu trước còn đang đọc: câu sau chờ đọc nối tiếp, không chồng tiếng', async () => {
    const segments: ScriptSegment[] = [
      { segmentId: 'a', text: 'A.', startMs: 1_000, endMs: 1_500 },
      { segmentId: 'b', text: 'B.', startMs: 2_000, endMs: 3_000 }
    ];
    const { video, audioCtx, scheduled, tick, tts } = setup(segments);
    video.currentTime = 1;
    await tts('a', 1_600);
    await tts('b', 500);
    video.currentTime = 2;
    audioCtx.currentTime += 1;
    tick();
    // Khung a = 900 ms, 1600 ms chỉ co được còn ~1231 ms ở 1.3x: b chờ thêm ~0.23 s.
    expect(scheduled[1].delaySec).toBeGreaterThan(0.2);
    expect(scheduled[1].delaySec).toBeLessThan(0.26);
  });

  it('tua: câu đã có giọng không gửi lại, câu chưa xong thì gửi lại; câu đã qua hẳn không phát', async () => {
    const { video, player, sent, scheduled, tick, tts } = setup(SCRIPT);
    video.paused = true;
    tick();
    video.paused = false;
    await tts('s1', 1_000);
    video.currentTime = 50;
    player.handleSeek();
    expect(sent.at(-1)).toEqual(['s3']);
    expect(scheduled).toEqual([]);
    video.currentTime = 0.8;
    player.handleSeek();
    expect(sent.at(-1)).toEqual(['s2']);
    // Về lại trước câu 1: giọng đã có được phát lại đúng mốc.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delaySec).toBeCloseTo(0.2, 3);
    video.currentTime = 30;
    player.handleSeek();
    expect(scheduled).toHaveLength(1);
  });

  it('chế độ chỉ phụ đề: hiện phụ đề đúng mốc, không cần giọng', async () => {
    const { video, player, subtitles, tick } = setup(SCRIPT, 'subtitle_only');
    player.handleSubtitle({ type: 'SUBTITLE_EVENT', sessionId: 's', timestamp: 0, segmentId: 's1', text: 'vi s1', startMs: 1_000, endMs: 3_000, generation: 1, action: 'show', scheduled: true });
    video.currentTime = 0.99;
    tick();
    await wait(30);
    expect(subtitles.map(item => item.id)).toEqual(['s1']);
  });
});

class IdleSTT implements STTProvider {
  readonly name = 'IdleSTT';
  createStream(): STTStreamSession {
    return { sendAudioChunk: () => {}, endStream: () => {}, abort: () => {} };
  }
}

const vi: TranslationProvider = { name: 'Vi', async translate(request) { return { translatedText: `Bản dịch câu ${request.startMs}.` }; } };

function tts(log: string[], delayMs = 10): TTSProvider {
  return {
    name: 'FakeTTS',
    async synthesize(request: TTSRequest): Promise<TTSResponse> {
      log.push(request.segmentId);
      await wait(delayMs);
      return { segmentId: request.segmentId, generation: request.generation, audioBase64: 'UklGRg==', mimeType: 'audio/wav', durationMs: 1_200, sampleRate: SAMPLE_RATE, channels: 1, cancelled: false };
    },
    cancelGeneration() {}
  };
}

function makePipeline(mode: 'dubbing_and_subtitle' | 'subtitle_only', log: string[], delayMs?: number) {
  const messages: ServerMessage[] = [];
  const pipeline = new RealtimePipeline(
    'pipe_script', mode, new IdleSTT(), new TranslationEngine(vi, undefined, { validateVietnamese: false }), tts(log, delayMs),
    { sendMessage: message => messages.push(message) }
  );
  pipeline.start();
  return { pipeline, messages };
}

const segs = (...starts: number[]): ScriptSegment[] => starts.map(startMs => ({ segmentId: `cap_${startMs}`, text: `Sentence at ${startMs}.`, startMs, endMs: startMs + 1_000 }));

describe('backend: thêm dấu câu cho phụ đề tự động', () => {
  it('CAPTION_WORDS -> SCRIPT_SENTENCES cùng requestId, mã câu theo mốc bắt đầu; lỗi thì trả error và danh sách rỗng', async () => {
    const punctuating: TranslationProvider = {
      ...vi,
      async punctuate(words) {
        if (words.length === 1) throw new Error('model missing');
        return [{ text: 'Hello there.', startMs: words[0].startMs, endMs: words[1].startMs + 300 }];
      }
    };
    const messages: ServerMessage[] = [];
    const pipeline = new RealtimePipeline(
      'pipe_punct', 'dubbing_and_subtitle', new IdleSTT(), new TranslationEngine(punctuating, undefined, { validateVietnamese: false }), tts([]),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    await pipeline.punctuateCaptions('r1', [{ text: 'hello', startMs: 1_000 }, { text: 'there', startMs: 1_400 }]);
    await pipeline.punctuateCaptions('r2', [{ text: 'x', startMs: 9 }]);
    const replies = messages.filter((message): message is ScriptSentencesMessage => message.type === 'SCRIPT_SENTENCES');
    expect(replies[0]).toMatchObject({ requestId: 'r1', segments: [{ segmentId: 'asr_1000', text: 'Hello there.', startMs: 1_000, endMs: 1_700 }] });
    expect(replies[1]).toMatchObject({ requestId: 'r2', segments: [], error: 'model missing' });
    pipeline.stop();
  });
});

describe('ScriptPipeline (backend): dịch và đọc trước', () => {
  it('xử lý theo thứ tự; mỗi câu gửi phụ đề rồi giọng đọc, cả hai có scheduled; câu trùng không làm lại', async () => {
    const log: string[] = [];
    const { pipeline, messages } = makePipeline('dubbing_and_subtitle', log);
    pipeline.handleScriptSegments(segs(1_000, 3_000), 1);
    pipeline.handleScriptSegments(segs(3_000, 5_000), 1);
    await wait(150);
    const out = messages.filter((message): message is SubtitleEventMessage | TTSChunkMessage => message.type === 'SUBTITLE_EVENT' || message.type === 'TTS_CHUNK');
    expect(out.map(message => `${message.type === 'TTS_CHUNK' ? 'tts' : 'sub'}:${message.segmentId}`)).toEqual([
      'sub:cap_1000', 'tts:cap_1000', 'sub:cap_3000', 'tts:cap_3000', 'sub:cap_5000', 'tts:cap_5000'
    ]);
    expect(out.every(message => message.scheduled === true)).toBe(true);
    expect((out[0] as SubtitleEventMessage).text).toBe('Bản dịch câu 1000.');
    expect(log).toEqual(['cap_1000', 'cap_3000', 'cap_5000']);
    pipeline.stop();
  });

  it('câu của lượt cũ (trước khi tua) bị bỏ; sau tua nhận câu của lượt mới', async () => {
    const log: string[] = [];
    const { pipeline, messages } = makePipeline('dubbing_and_subtitle', log, 40);
    pipeline.handleScriptSegments(segs(1_000, 3_000, 5_000), 1);
    await wait(15);
    pipeline.handleSeek(1_000, 60_000);
    pipeline.handleScriptSegments(segs(7_000), 1);
    pipeline.handleScriptSegments(segs(60_000), 2);
    await wait(200);
    const tts = messages.filter((message): message is TTSChunkMessage => message.type === 'TTS_CHUNK');
    expect(tts.map(message => `${message.segmentId}@${message.generation}`)).toEqual(['cap_60000@2']);
    expect(log).toEqual(['cap_1000', 'cap_60000']);
    pipeline.stop();
  });

  it('chế độ chỉ phụ đề: không tổng hợp giọng', async () => {
    const log: string[] = [];
    const { pipeline, messages } = makePipeline('subtitle_only', log);
    pipeline.handleScriptSegments(segs(1_000), 1);
    await wait(50);
    expect(messages.filter(message => message.type === 'TTS_CHUNK')).toHaveLength(0);
    expect(messages.filter(message => message.type === 'SUBTITLE_EVENT')).toHaveLength(1);
    expect(log).toEqual([]);
    pipeline.stop();
  });
});
