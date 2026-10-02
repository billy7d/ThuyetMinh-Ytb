# Model selection và kiểm chứng — VietDub local

Ngày rà soát: 2026-09-24. Người vận hành đã xác nhận tải đúng bộ model theo tài
liệu này. Trạng thái cài đặt và kiểm tra thực tế được ghi ở cuối tài liệu.

## Phần cứng đích và lựa chọn

- CPU Intel Core i5-9400F, 6 nhân/6 luồng, RAM 16 GB: chọn inference CPU,
  thread giới hạn 6 và để GTX 1660 SUPER rảnh cho browser.
- STT: `Systran/faster-whisper-base.en`, model CTranslate2, revision
  `3d3d5dee26484f91867d81cb899cfcf72b96be6c`, MIT. `model.bin` có LFS SHA-256
  dự kiến `2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef`
  và kích thước 145,216,508 bytes; tổng các file runtime bắt buộc khoảng 148 MB.
- Translation: `Helsinki-NLP/opus-mt-en-vi`, revision
  `989c9fb9ec63987901022baf0182dcec3e149be6`, Apache-2.0. Chỉ lấy các file
  PyTorch/SentencePiece cần cho Transformers, không lấy bản `tf_model.h5` trùng
  lặp; `pytorch_model.bin` có LFS SHA-256 dự kiến
  `50eec80a5807001b9efdf06e76a2d3a7ed61d798af6bc96539ea7679f7d97a99` và kích
  thước 288,866,577 bytes.
- Vietnamese TTS: `pnnbao-ump/VieNeu-TTS-v3-Turbo`, revision
  `5f2a3e93092efaba9153253ff5f2e6a8e810e4f2`, Apache-2.0; chọn graph
  `onnx_update` fp32 khoảng 475.4 MB, đầu ra 48 kHz. Tài liệu VieNeu cảnh báo
  graph int8 có thể méo trên CPU không có VNNI; i5-9400F không có VNNI nên không
  chọn nhánh đó. Codec tách riêng:
  `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`, revision
  `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae`, Apache-2.0, khoảng 90.6 MB.
  SDK `vieneu==3.8.3` (Apache-2.0, phát hành 2026-09-23) và code engine được
  cài riêng không kéo Gradio/UI; SEA-G2P `0.10.0` làm phonemizer.
- Tổng trọng số/graph và codec dự kiến 1,005,369,274 bytes (xấp xỉ 1.005 GB, 958.8 MiB).

## File graph TTS và digest upstream đã đọc

Các digest dưới đây là LFS SHA-256 do Hugging Face metadata công khai trả về;
file nhỏ không có LFS digest sẽ được hash SHA-256 tại máy sau khi tải. Không
được dùng Git blob SHA-1 thay cho checksum file.

VieNeu `onnx_update/` fp32:

| File | Bytes | LFS SHA-256 |
|---|---:|---|
| `vieneu_acoustic_cached.onnx` | 7,207,223 | `f631e3387c788c3d8b9a5ac5df94952af5bc4c4d1049ff8a751e76a246fff2d4` |
| `vieneu_backbone_shared.data` | 415,319,040 | `c7c072193db33d0542457e2612c7272c44c4279d1cafaf0aa4c379964911db2f` |
| `vieneu_decode_step.onnx` | 306,134 | `bedc379cea61ea5d616312750d95ad3924e055856662d19187a889a5edc24ceb` |
| `vieneu_prefill.onnx` | 324,499 | `27f8b064f6b57b5448e95d095f1959588c005d614678045c2b97ecccf3b7a0f7` |
| `vieneu_v3_heads.npz` | 52,219,622 | `fb22484baa424bbb775133a6e5f0d00d6299b2b256fbe3312a864b85b9aed01e` |

OpenMOSS codec:

| File | Bytes | LFS SHA-256 |
|---|---:|---|
| `moss_audio_tokenizer_decode_full.onnx` | 681,902 | `0fbbafe3fd4afa2a019af5c5ced204af6e2d1db044fa40f021525d2aee95b4ac` |
| `moss_audio_tokenizer_decode_shared.data` | 44,198,912 | `e69d52e0f4e84ca27850557ee54face46632d3a5a16c89bd246c7c408466dcad` |
| `moss_audio_tokenizer_decode_step.onnx` | 351,400 | `9527c86a29e1837edec1f74db57d5eeaadb3a715af3382703566460afed25855` |
| `moss_audio_tokenizer_encode.data` | 44,507,136 | `aa751265b2bab2887eac224484546b194875aa7494b607115439b3dc6b228a2c` |
| `moss_audio_tokenizer_encode.onnx` | 815,775 | `eadea4a645abdcf98714c7aead122ee2ce7da6e080f9f80b977cd1ca8e19473a` |

## Kết quả tải và xác minh

- User consent: đã nhận ngày 2026-09-24 cho đúng bộ model/revision trong tài liệu.
- Runtime root: `E:\VietDub-AI`; model root:
  `E:\VietDub-AI\models`; cache và evidence cũng nằm trên ổ E:, ngoài Git repo.
- Manifest thực tế: `E:\VietDub-AI\models\manifest.json`; tổng 25 artifact,
  1,005,369,274 bytes. Local size/SHA-256 và upstream revision/digest được đối
  chiếu; backend `LocalModelManager` báo cả ba component `ready`.
- License đã ghi trong manifest: STT MIT; OPUS-MT, VieNeu và OpenMOSS codec
  Apache-2.0. Các model và dependency đều chạy local; không cấu hình cloud/paid
  fallback.
- `MODEL_DOWNLOAD=PASS`, `LOCAL_CHECKSUMS=PASS`, `LICENSE_METADATA=PASS`;
  model weights không được thêm vào repository.

Nguồn chính: [faster-whisper model](https://huggingface.co/Systran/faster-whisper-base.en),
[OPUS-MT en-vi](https://huggingface.co/Helsinki-NLP/opus-mt-en-vi),
[VieNeu v3 Turbo](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo),
[OpenMOSS ONNX codec](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX),
[VieNeu SDK](https://github.com/pnnbao97/VieNeu-TTS).
