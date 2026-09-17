export interface BenchmarkSample {
  id: string;
  domain: 'conversational' | 'science' | 'news' | 'technology' | 'finance' | 'fast_speech' | 'accents' | 'noisy';
  sourceText: string;
  referenceVietnamese: string;
  criticalEntities: string[];
  notes: string;
}

export const BENCHMARK_DATASET: BenchmarkSample[] = [
  // 1. Conversational (5 samples)
  {
    id: 'conv_01',
    domain: 'conversational',
    sourceText: "Let's break it down.",
    referenceVietnamese: "Chúng ta cùng phân tích kỹ hơn nhé.",
    criticalEntities: [],
    notes: "PRD reference idiom"
  },
  {
    id: 'conv_02',
    domain: 'conversational',
    sourceText: "That's not the whole story.",
    referenceVietnamese: "Nhưng đó vẫn chưa phải là toàn bộ câu chuyện.",
    criticalEntities: [],
    notes: "PRD reference idiom"
  },
  {
    id: 'conv_03',
    domain: 'conversational',
    sourceText: "It turns out we were wrong.",
    referenceVietnamese: "Hóa ra chúng ta đã nhầm.",
    criticalEntities: [],
    notes: "PRD reference idiom"
  },
  {
    id: 'conv_04',
    domain: 'conversational',
    sourceText: "I'm going to walk you through it.",
    referenceVietnamese: "Tôi sẽ hướng dẫn bạn từng bước.",
    criticalEntities: [],
    notes: "PRD reference idiom"
  },
  {
    id: 'conv_05',
    domain: 'conversational',
    sourceText: "At the end of the day, we need to focus on what really matters.",
    referenceVietnamese: "Sau cùng thì, chúng ta cần tập trung vào điều thực sự quan trọng.",
    criticalEntities: [],
    notes: "Conversational idiom"
  },

  // 2. Science & Explanation (4 samples)
  {
    id: 'sci_01',
    domain: 'science',
    sourceText: "The James Webb Space Telescope observed galaxy JADES-GS-z14-0 at a redshift of 14.32.",
    referenceVietnamese: "Kính viễn vọng không gian James Webb đã quan sát thiên hà JADES-GS-z14-0 ở độ dịch chuyển đỏ 14.32.",
    criticalEntities: ["James Webb Space Telescope", "JADES-GS-z14-0", "14.32"],
    notes: "Astronomical terms and precise numerical coordinates"
  },
  {
    id: 'sci_02',
    domain: 'science',
    sourceText: "Photosynthesis converts carbon dioxide and water into glucose and oxygen using solar energy.",
    referenceVietnamese: "Quá trình quang hợp chuyển đổi carbon dioxide và nước thành glucose và oxy nhờ năng lượng mặt trời.",
    criticalEntities: ["carbon dioxide", "glucose", "oxygen"],
    notes: "Biochemical process explanation"
  },
  {
    id: 'sci_03',
    domain: 'science',
    sourceText: "The boiling point of liquid nitrogen is minus 195.8 degrees Celsius.",
    referenceVietnamese: "Điểm sôi của nitơ lỏng là âm 195.8 độ C.",
    criticalEntities: ["-195.8", "Celsius", "nitơ lỏng"],
    notes: "Precise scientific measurement and negative number"
  },
  {
    id: 'sci_04',
    domain: 'science',
    sourceText: "CRISPR-Cas9 enables precise genome editing by targeting specific DNA sequences.",
    referenceVietnamese: "CRISPR-Cas9 cho phép chỉnh sửa bộ gen chính xác bằng cách nhắm mục tiêu vào các chuỗi DNA cụ thể.",
    criticalEntities: ["CRISPR-Cas9", "DNA"],
    notes: "Genetics technology nomenclature"
  },

  // 3. News & Current Events (4 samples)
  {
    id: 'news_01',
    domain: 'news',
    sourceText: "Prime Minister announced a 2.5 billion dollar stimulus package on Monday morning.",
    referenceVietnamese: "Thủ tướng đã công bố gói kích thích kinh tế trị giá 2.5 tỷ đô la vào sáng thứ Hai.",
    criticalEntities: ["2.5 tỷ đô la", "thứ Hai"],
    notes: "Currency amounts and timeline"
  },
  {
    id: 'news_02',
    domain: 'news',
    sourceText: "Rescue operations are underway in Hanoi following heavy rainfall of over 150 millimeters.",
    referenceVietnamese: "Các chiến dịch cứu hộ đang được tiến hành tại Hà Nội sau đợt mưa lớn hơn 150 milimét.",
    criticalEntities: ["Hà Nội", "150 milimét"],
    notes: "Geographic proper noun and metric unit"
  },
  {
    id: 'news_03',
    domain: 'news',
    sourceText: "The United Nations General Assembly convened in New York to discuss climate change initiatives.",
    referenceVietnamese: "Đại hội đồng Liên Hợp Quốc đã nhóm họp tại New York để thảo luận về các sáng kiến biến đổi khí hậu.",
    criticalEntities: ["Liên Hợp Quốc", "New York"],
    notes: "International organization and location"
  },
  {
    id: 'news_04',
    domain: 'news',
    sourceText: "Health officials reported a 40 percent decrease in seasonal influenza cases this quarter.",
    referenceVietnamese: "Các quan chức y tế báo cáo số ca cúm mùa đã giảm 40 phần trăm trong quý này.",
    criticalEntities: ["40%", "cúm mùa"],
    notes: "Statistical percentage and epidemiological term"
  },

  // 4. Technology & AI (4 samples)
  {
    id: 'tech_01',
    domain: 'technology',
    sourceText: "Large language models leverage transformer architecture with multi-head self-attention mechanisms.",
    referenceVietnamese: "Các mô hình ngôn ngữ lớn tận dụng kiến trúc transformer với cơ chế tự chú ý đa đầu.",
    criticalEntities: ["transformer", "mô hình ngôn ngữ lớn"],
    notes: "Modern AI terminology"
  },
  {
    id: 'tech_02',
    domain: 'technology',
    sourceText: "The system processes WebSocket messages with an end-to-end latency under 300 milliseconds.",
    referenceVietnamese: "Hệ thống xử lý các thông điệp WebSocket với độ trễ đầu cuối dưới 300 mili giây.",
    criticalEntities: ["WebSocket", "300", "mili giây"],
    notes: "Networking protocol and millisecond latency measurement"
  },
  {
    id: 'tech_03',
    domain: 'technology',
    sourceText: "Kubernetes orchestrates containerized workloads across 128 cluster nodes.",
    referenceVietnamese: "Kubernetes điều phối các khối lượng công việc được đóng gói trong container trên 128 nút cụm.",
    criticalEntities: ["Kubernetes", "128"],
    notes: "Cloud infrastructure terminology"
  },
  {
    id: 'tech_04',
    domain: 'technology',
    sourceText: "Vector database indexing accelerates similarity search for retrieval-augmented generation.",
    referenceVietnamese: "Việc đánh chỉ mục cơ sở dữ liệu vector giúp tăng tốc tìm kiếm tương đồng cho mô hình RAG.",
    criticalEntities: ["cơ sở dữ liệu vector", "RAG"],
    notes: "Vector search and RAG architecture"
  },

  // 5. Finance & Economy (4 samples)
  {
    id: 'fin_01',
    domain: 'finance',
    sourceText: "The market is pricing in a rate cut.",
    referenceVietnamese: "Thị trường đang phản ánh kỳ vọng lãi suất sẽ được cắt giảm.",
    criticalEntities: ["lãi suất"],
    notes: "PRD reference sentence"
  },
  {
    id: 'fin_02',
    domain: 'finance',
    sourceText: "The Federal Reserve maintained the federal funds rate between 5.25 and 5.50 percent.",
    referenceVietnamese: "Cục Dự trữ Liên bang (Fed) giữ nguyên lãi suất quỹ liên bang ở mức từ 5.25 đến 5.50 phần trăm.",
    criticalEntities: ["Cục Dự trữ Liên bang (Fed)", "5.25", "5.50%"],
    notes: "Central bank and interest rate ranges"
  },
  {
    id: 'fin_03',
    domain: 'finance',
    sourceText: "Annual inflation slowed to 2.8 percent while GDP expanded by 3.1 percent.",
    referenceVietnamese: "Lạm phát hàng năm đã chậm lại ở mức 2.8 phần trăm trong khi GDP tăng trưởng 3.1 phần trăm.",
    criticalEntities: ["2.8%", "GDP", "3.1%"],
    notes: "Economic indicators and percentage precision"
  },
  {
    id: 'fin_04',
    domain: 'finance',
    sourceText: "The S&P 500 closed 45 points higher, gaining 0.8 percent on strong earnings reports.",
    referenceVietnamese: "Chỉ số S&P 500 chốt phiên tăng 45 điểm, tương đương mức tăng 0.8 phần trăm nhờ báo cáo lợi nhuận khả quan.",
    criticalEntities: ["S&P 500", "45", "0.8%"],
    notes: "Stock index movement and points"
  },

  // 6. Fast Speech (>180 WPM) (3 samples)
  {
    id: 'fast_01',
    domain: 'fast_speech',
    sourceText: "If you really think about what we just discussed, the entire paradigm completely shifts overnight.",
    referenceVietnamese: "Nếu bạn thực sự suy ngẫm về những gì chúng ta vừa thảo luận, toàn bộ cục diện đã hoàn toàn thay đổi chỉ sau một đêm.",
    criticalEntities: [],
    notes: "High tempo conversational flow"
  },
  {
    id: 'fast_02',
    domain: 'fast_speech',
    sourceText: "Don't blink because within thirty seconds we are going to demonstrate five different features simultaneously.",
    referenceVietnamese: "Đừng chớp mắt nhé vì chỉ trong vòng ba mươi giây nữa chúng tôi sẽ trình diễn năm tính năng khác nhau cùng một lúc.",
    criticalEntities: ["ba mươi giây", "năm tính năng"],
    notes: "Rapid video presenter cadence"
  },
  {
    id: 'fast_03',
    domain: 'fast_speech',
    sourceText: "There's no time to hesitate when the market swings ten percent in less than an hour.",
    referenceVietnamese: "Không có thời gian để do dự khi thị trường biến động tới mười phần trăm trong chưa đầy một giờ.",
    criticalEntities: ["10%", "một giờ"],
    notes: "Urgent fast financial commentary"
  },

  // 7. Regional Accents & Colloquialisms (3 samples)
  {
    id: 'acc_01',
    domain: 'accents',
    sourceText: "Right then, let's crack on with sorting out these persistent audio buffer issues.",
    referenceVietnamese: "Được rồi, chúng ta hãy bắt tay ngay vào việc xử lý các sự cố bộ đệm âm thanh kéo dài này nhé.",
    criticalEntities: [],
    notes: "British colloquial phrasing ('crack on with')"
  },
  {
    id: 'acc_02',
    domain: 'accents',
    sourceText: "Y'all need to pay close attention to this particular configuration parameter right here.",
    referenceVietnamese: "Các bạn cần chú ý kỹ đến thông số cấu hình cụ thể ngay tại đây.",
    criticalEntities: [],
    notes: "Southern US colloquialism ('y'all')"
  },
  {
    id: 'acc_03',
    domain: 'accents',
    sourceText: "No worries at all mate, we can get this sorted out in no time flat.",
    referenceVietnamese: "Không có gì phải lo cả bạn nhé, chúng ta có thể giải quyết việc này trong tích tắc.",
    criticalEntities: [],
    notes: "Australian conversational phrasing"
  },

  // 8. Noisy Environment / Background Audio (3 samples)
  {
    id: 'noisy_01',
    domain: 'noisy',
    sourceText: "Despite the loud cafe background chatter, the microphone picked up every single spoken syllable.",
    referenceVietnamese: "Bất chấp tiếng ồn ào xung quanh của quán cà phê, micro vẫn thu lại từng âm tiết được phát ra.",
    criticalEntities: [],
    notes: "Testing noise resilience"
  },
  {
    id: 'noisy_02',
    domain: 'noisy',
    sourceText: "The presenter continued speaking over the background synthesizer music at 75 decibels.",
    referenceVietnamese: "Người dẫn chương trình vẫn tiếp tục nói trên nền nhạc điện tử ở mức âm lượng 75 decibel.",
    criticalEntities: ["75 decibel"],
    notes: "Speech with background BGM"
  },
  {
    id: 'noisy_03',
    domain: 'noisy',
    sourceText: "During the live outdoor demonstration, wind noise occasionally hit the acoustic sensors.",
    referenceVietnamese: "Trong buổi trình diễn trực tiếp ngoài trời, tiếng gió thỉnh thoảng tạt vào các cảm biến âm thanh.",
    criticalEntities: [],
    notes: "Outdoor ambient noise conditions"
  }
];
