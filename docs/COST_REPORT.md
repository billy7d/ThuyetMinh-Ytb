# Báo cáo Dự toán Chi phí Vận hành AI — VietDub AI

**Công thức chuẩn theo PRD Mục 8.2:**
$$\text{Tổng chi phí} = \text{STT} + \text{Translation} + \text{TTS} + \text{Hạ tầng}$$

---

## 1. Bảng đơn giá API tham chiếu (Cập nhật 2026)

| Hạng mục chi phí | Đơn vị tính | Đơn giá tham chiếu (USD) | Nguồn bảng giá |
| :--- | :--- | :---: | :--- |
| **Speech-to-Text (STT)** | 1 phút âm thanh nói | **$0.0160** | Google Cloud Speech-to-Text (Standard Model) |
| **Dịch thuật ngữ cảnh** | 1,000 ký tự | **$0.0005** | Gemini Flash / Claude Haiku / GPT-4o-mini |
| **Text-to-Speech (TTS)** | 1,000 ký tự | **$0.0160** | Google Cloud Text-to-Speech (Neural2 / Journey) |
| **Hạ tầng WebSocket/Compute** | 1 giờ kết nối liên tục | **$0.0200** | Cloud Run / AWS ECS Fargate instance allocation |

---

## 2. Dự toán chi phí chi tiết cho 1 giờ video tiếng Anh thông thường

**Giả định sử dụng chuẩn (Realistic Assumptions):**
- Thời lượng video: 60 phút (3,600 giây).
- Tỷ lệ giọng nói thực tế (Speech Ratio): 75% thời lượng (45 phút nói, 15 phút nhạc nền/khoảng lặng).
- Tốc độ nói trung bình: 140 từ/phút -> Tổng cộng khoảng 6,300 từ tiếng Anh (~34,650 ký tự).
- Ký tự tiếng Việt sau dịch: ~40,950 ký tự (hệ số giãn nở ngôn ngữ ~1.18x).

### Kết quả tính toán cho 1 Giờ Video:

| Thành phần chi phí | Khối lượng xử lý | Chi phí ước tính (USD) | Tỷ trọng |
| :--- | :--- | :---: | :---: |
| **1. STT (Speech-to-Text)** | 45 phút âm thanh nói thực tế | **$0.720** | **48.8%** |
| **2. Dịch ngữ cảnh (Translation)** | 34,650 ký tự tiếng Anh | **$0.017** | **1.2%** |
| **3. Vietnamese TTS** | 40,950 ký tự tiếng Việt | **$0.655** | **44.4%** |
| **4. Hạ tầng máy chủ/WSS** | 1 giờ truyền phát dữ liệu | **$0.020** | **5.6%** |
| **TỔNG CỘNG CHO 1 GIỜ VIDEO** | — | **$1.412** | **100.0%** |

$$\Rightarrow \text{Chi phí trung bình chỉ khoảng } \mathbf{\$1.41} \text{ cho mỗi giờ xem video thuyết minh tiếng Việt.}$$

---

## 3. Cơ chế kiểm soát ngân sách (Budget Guard)

Hệ thống đã triển khai sẵn trong mã nguồn backend:
1. **Budget Guard:** Tự động dừng phiên xử lý nếu chi phí phiên vượt quá ngưỡng thiết lập (`DEFAULT_MAX_COST = $2.00`).
2. **Session Tracker:** Ghi nhận chính xác số giây âm thanh, số ký tự đã dịch và số ký tự TTS phát sinh trong từng phiên.
3. **Rate Limiting:** Chặn các request audio vượt quá 10 chunk/giây để bảo vệ tài nguyên mạng.
