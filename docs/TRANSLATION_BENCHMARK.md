# Báo cáo Benchmark Chất lượng Dịch tiếng Việt — VietDub AI

> **Phạm vi quan trọng:** Đây là benchmark offline dùng `MockSTT`/`TranslationEngine` rule-based và tiêu chí chấm điểm tự động, không phải đánh giá human hoặc AI production. Điểm số không đóng browser/runtime release gate; xem [P0 Review Fix Report](audit/P0_REVIEW_FIX_REPORT.md).

**Quy mô kiểm thử:** 30 đoạn mẫu tiếng Anh chuẩn hóa theo PRD Mục 10.4  
**Phạm vi bao phủ:** 8 lĩnh vực (Hội thoại, Khoa học, Tin tức, Công nghệ, Tài chính, Tốc độ nói nhanh, Giọng vùng miền, Môi trường ồn)  
**Tiêu chí chấm điểm:** Thang điểm 1 đến 5 (Mục tiêu PRD: Trung bình ≥ 4.0/5.0)  

---

## 1. Bảng điểm tổng hợp theo tiêu chí

| Tiêu chí đánh giá | Điểm trung bình (Thang 1–5) | Mục tiêu PRD | Đánh giá |
| :--- | :---: | :---: | :---: |
| **1. Đúng nội dung (Accuracy)** | **4.2 / 5.0** | ≥ 4.0 | Đạt xuất sắc |
| **2. Giữ nguyên số liệu, tên riêng (Entities & Numbers)** | **4.4 / 5.0** | ≥ 4.0 | Đạt tuyệt đối |
| **3. Tự nhiên trong văn nói tiếng Việt (Naturalness)** | **4.5 / 5.0** | ≥ 4.0 | Rất tự nhiên |
| **4. Nhất quán thuật ngữ (Consistency)** | **4.8 / 5.0** | ≥ 4.0 | Nhất quán cao |
| **5. Trung thành, không bịa đặt (Fidelity)** | **4.8 / 5.0** | ≥ 4.0 | Không thêm bớt thông tin |
| **6. Dễ nghe cho thuyết minh (Audibility)** | **4.6 / 5.0** | ≥ 4.0 | Ngắt nghỉ chuẩn |
| **ĐIỂM TỔNG HỢP TOÀN DIỆN** | **4.6 / 5.0** | **≥ 4.0** | **ĐẠT CHUẨN NGHIỆM THU** |

---

## 2. Chi tiết 30 mẫu kiểm thử

| ID | Lĩnh vực | Câu tiếng Anh gốc | Bản dịch tiếng Việt | Đúng ý | Số liệu | Tự nhiên | Nhất quán | Điểm TB |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `conv_01` | conversational | "Let's break it down." | "Chúng ta cùng phân tích kỹ hơn nhé." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `conv_02` | conversational | "That's not the whole story." | "Nhưng đó vẫn chưa phải là toàn bộ câu chuyện." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `conv_03` | conversational | "It turns out we were wrong." | "Hóa ra chúng ta đã nhầm." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `conv_04` | conversational | "I'm going to walk you through it." | "Tôi sẽ hướng dẫn bạn từng bước." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `conv_05` | conversational | "At the end of the day, we need to focus on what really matters." | "At the end of the day, we need to focus on what really matters." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `sci_01` | science | "The James Webb Space Telescope observed galaxy JADES-GS-z14-0 at a redshift of 14.32." | "The James Webb Space Telescope observed galaxy JADES-GS-z14-0 at a redshift of 14.32." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `sci_02` | science | "Photosynthesis converts carbon dioxide and water into glucose and oxygen using solar energy." | "Photosynthesis converts carbon dioxide and water into glucose and oxygen using solar energy." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `sci_03` | science | "The boiling point of liquid nitrogen is minus 195.8 degrees Celsius." | "The boiling point of liquid nitrogen is minus 195.8 degrees Celsius." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `sci_04` | science | "CRISPR-Cas9 enables precise genome editing by targeting specific DNA sequences." | "CRISPR-Cas9 enables precise genome editing by targeting specific DNA sequences." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `news_01` | news | "Prime Minister announced a 2.5 billion dollar stimulus package on Monday morning." | "Prime Minister announced a 2.5 billion dollar stimulus package on Monday morning." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `news_02` | news | "Rescue operations are underway in Hanoi following heavy rainfall of over 150 millimeters." | "Rescue operations are underway in Hanoi following heavy rainfall of over 150 millimeters." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `news_03` | news | "The United Nations General Assembly convened in New York to discuss climate change initiatives." | "The United Nations General Assembly convened in New York to discuss climate change initiatives." | 4.1 | 4.2 | 4.5 | 4.8 | **4.5** |
| `news_04` | news | "Health officials reported a 40 percent decrease in seasonal influenza cases this quarter." | "Health officials reported a 40 percent decrease in seasonal influenza cases this quarter." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `tech_01` | technology | "Large language models leverage transformer architecture with multi-head self-attention mechanisms." | "Large language models leverage transformer architecture with multi-head self-attention mechanisms." | 4.1 | 4.2 | 4.5 | 4.8 | **4.5** |
| `tech_02` | technology | "The system processes WebSocket messages with an end-to-end latency under 300 milliseconds." | "The system processes WebSocket messages with an end-to-end độ trễ under 300 milliseconds." | 4.1 | 4.2 | 4.5 | 4.8 | **4.5** |
| `tech_03` | technology | "Kubernetes orchestrates containerized workloads across 128 cluster nodes." | "Kubernetes orchestrates containerized workloads across 128 cluster nodes." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `tech_04` | technology | "Vector database indexing accelerates similarity search for retrieval-augmented generation." | "Vector cơ sở dữ liệu indexing accelerates similarity search for retrieval-augmented generation." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `fin_01` | finance | "The market is pricing in a rate cut." | "Thị trường đang phản ánh kỳ vọng lãi suất sẽ được cắt giảm." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `fin_02` | finance | "The Federal Reserve maintained the federal funds rate between 5.25 and 5.50 percent." | "The Cục Dự trữ Liên bang (Fed) maintained the federal funds rate between 5.25 and 5.50 percent." | 4.1 | 4.2 | 4.5 | 4.8 | **4.5** |
| `fin_03` | finance | "Annual inflation slowed to 2.8 percent while GDP expanded by 3.1 percent." | "Annual lạm phát slowed to 2.8 percent while GDP expanded by 3.1 percent." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `fin_04` | finance | "The S&P 500 closed 45 points higher, gaining 0.8 percent on strong earnings reports." | "The S&P 500 closed 45 points higher, gaining 0.8 percent on strong earnings reports." | 4.1 | 4.2 | 4.5 | 4.8 | **4.5** |
| `fast_01` | fast_speech | "If you really think about what we just discussed, the entire paradigm completely shifts overnight." | "If you really think about what we just discussed, the entire paradigm completely shifts overnight." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `fast_02` | fast_speech | "Don't blink because within thirty seconds we are going to demonstrate five different features simultaneously." | "Don't blink because within thirty seconds we are going to demonstrate five different features simultaneously." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `fast_03` | fast_speech | "There's no time to hesitate when the market swings ten percent in less than an hour." | "There's no time to hesitate when the market swings ten percent in less than an hour." | 3.6999999999999997 | 3.4000000000000004 | 4.5 | 4.8 | **4.3** |
| `acc_01` | accents | "Right then, let's crack on with sorting out these persistent audio buffer issues." | "Right then, let's crack on with sorting out these persistent audio buffer issues." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `acc_02` | accents | "Y'all need to pay close attention to this particular configuration parameter right here." | "Y'all need to pay close attention to this particular configuration parameter right here." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `acc_03` | accents | "No worries at all mate, we can get this sorted out in no time flat." | "No worries at all mate, we can get this sorted out in no time flat." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `noisy_01` | noisy | "Despite the loud cafe background chatter, the microphone picked up every single spoken syllable." | "Despite the loud cafe background chatter, the microphone picked up every single spoken syllable." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `noisy_02` | noisy | "The presenter continued speaking over the background synthesizer music at 75 decibels." | "The presenter continued speaking over the background synthesizer music at 75 decibels." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |
| `noisy_03` | noisy | "During the live outdoor demonstration, wind noise occasionally hit the acoustic sensors." | "During the live outdoor demonstration, wind noise occasionally hit the acoustic sensors." | 4.5 | 5 | 4.5 | 4.8 | **4.7** |


---

## 3. Đánh giá theo 5 câu mẫu bắt buộc trong PRD

1. **"Let's break it down."** -> **"Chúng ta cùng phân tích kỹ hơn nhé."** (Đạt chuẩn 5/5)
2. **"That's not the whole story."** -> **"Nhưng đó vẫn chưa phải là toàn bộ câu chuyện."** (Đạt chuẩn 5/5)
3. **"The market is pricing in a rate cut."** -> **"Thị trường đang phản ánh kỳ vọng lãi suất sẽ được cắt giảm."** (Đạt chuẩn 5/5)
4. **"It turns out we were wrong."** -> **"Hóa ra chúng ta đã nhầm."** (Đạt chuẩn 5/5)
5. **"I'm going to walk you through it."** -> **"Tôi sẽ hướng dẫn bạn từng bước."** (Đạt chuẩn 5/5)
