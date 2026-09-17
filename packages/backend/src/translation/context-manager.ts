export interface ConfirmedContextItem {
  sourceText: string;
  translatedText: string;
  timestampMs: number;
}

export class ContextManager {
  private history: ConfirmedContextItem[] = [];
  private maxHistoryLength: number;
  private terminologyMap: Map<string, string> = new Map();
  private detectedTopic: string = 'Chung';

  constructor(maxHistoryLength = 5) {
    this.maxHistoryLength = maxHistoryLength;
    this.initializeDefaultTerminology();
  }

  private initializeDefaultTerminology(): void {
    // Seed common tech / finance / general terminology
    this.terminologyMap.set('rate cut', 'cắt giảm lãi suất');
    this.terminologyMap.set('interest rate', 'lãi suất');
    this.terminologyMap.set('inflation', 'lạm phát');
    this.terminologyMap.set('Federal Reserve', 'Cục Dự trữ Liên bang (Fed)');
    this.terminologyMap.set('artificial intelligence', 'trí tuệ nhân tạo');
    this.terminologyMap.set('machine learning', 'học máy');
    this.terminologyMap.set('large language model', 'mô hình ngôn ngữ lớn');
    this.terminologyMap.set('open source', 'mã nguồn mở');
    this.terminologyMap.set('real-time', 'thời gian thực');
    this.terminologyMap.set('latency', 'độ trễ');
    this.terminologyMap.set('streaming', 'phát trực tiếp/truyền phát');
    this.terminologyMap.set('API', 'API');
    this.terminologyMap.set('database', 'cơ sở dữ liệu');
  }

  addConfirmed(sourceText: string, translatedText: string, timestampMs: number): void {
    this.history.push({ sourceText, translatedText, timestampMs });
    if (this.history.length > this.maxHistoryLength) {
      this.history.shift();
    }
  }

  getHistory(): ConfirmedContextItem[] {
    return [...this.history];
  }

  formatContextPrompt(): string {
    if (this.history.length === 0) return '';
    return this.history
      .map((item, idx) => `[Câu ${idx + 1}] EN: "${item.sourceText}" -> VI: "${item.translatedText}"`)
      .join('\n');
  }

  getTerminology(): Record<string, string> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.terminologyMap.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  setTerm(englishTerm: string, vietnameseTerm: string): void {
    this.terminologyMap.set(englishTerm.toLowerCase(), vietnameseTerm);
  }

  getTerm(englishTerm: string): string | undefined {
    return this.terminologyMap.get(englishTerm.toLowerCase());
  }

  setTopic(topic: string): void {
    this.detectedTopic = topic;
  }

  getTopic(): string {
    return this.detectedTopic;
  }

  reset(): void {
    this.history = [];
    this.detectedTopic = 'Chung';
  }
}
