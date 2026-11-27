# BÁO CÁO TOÀN DIỆN: AUDIT DEAD CODE, COMMENT VÀ HƯỚNG DẪN CHỐNG HALLUCINATION CHO AI AGENT

- **Dự án:** `minhmiceproxy` (Proxy Checker / Single-Account Antigravity Rotator)
- **Ngày thực hiện:** 24/11/2026
- **Trạng thái:** Audit ứng viên; các mục xóa cần xác minh theo confidence boundaries bên dưới

## Audit review — confidence boundaries

Đây là danh sách ứng viên, không phải lệnh xóa tự động. Kết quả `0 caller` chỉ chứng minh không có caller tĩnh trong tập file đã quét; nó không loại trừ dynamic import, external consumer, CLI/deployment reference, hoặc dữ liệu vận hành.

- `src/db/migrations/sync/0000_baseline.sql` và metadata **vẫn tồn tại**. `src/server/backup/backup-service.ts` và `deploy/pi/deploy.sh` còn tham chiếu `router-sync.sqlite3`; chưa được kết luận xóa `src/db/sync/`.
- `backups/databases/*.sqlite3`, `backups/pool-state.json` và dữ liệu runtime **không phải dead code**. Không xóa nếu chưa có quyết định retention/migration riêng.
- Thư mục rỗng không tạo code/runtime behavior; Git không lưu thư mục rỗng. Chỉ cần xóa nếu có file placeholder hoặc tooling yêu cầu.
- `crypto-envelope.ts`, `server-interactive-updater.ts`, `activity-log.ts`, `rotateAntigravityAccounts` và `nineRouterAuthMode` cần kiểm tra deployment/CLI/external integration trước khi xóa. Test-only không đồng nghĩa dead nếu test đang bảo vệ contract dự kiến.
- Các nhận định chắc hơn: component UI không có import, re-export `src/components/sidebar.tsx` không có caller, và commented-out code. Những mục này có thể xử lý trước.

### Comment deletion policy

Xóa comment giải thích do người viết trong mã nguồn, test, script và CSS; gồm JSDoc thuần mô tả, tiêu đề phân vùng, code bị comment và ghi chú lịch sử. Giữ nguyên shebang, TypeScript `/// <reference ...>`, directive lint/compiler, JSDoc có tác dụng định kiểu, thông báo bản quyền bắt buộc và file generated/vendor. Không sửa SQL migration đã phát hành: `src/db/common/migrate.ts:16–17` băm cả nội dung baseline, nên xóa comment cũng đổi checksum. Không xóa tài liệu Markdown.

Tách comment-only khỏi dead-code cleanup. Dùng parser theo từng loại file, không strip bằng regex toàn repo: `//` trong URL, chuỗi, template hoặc JSX text không phải comment. Giữ nguyên code ngoài vùng comment; chạy check đúng bề mặt bị đổi.

---

## 1. TỔNG QUAN VÀ PHƯƠNG PHÁP AUDIT

### 1.1. Phạm vi khảo sát (Scope)
Quét toàn diện cây thư mục dự án gồm 150+ file mã nguồn (`src/`, `tests/`, `scripts/`, `backups/`, `.agents/skills/`):
- Toàn bộ UI Components (shadcn & custom components).
- Hệ thống cơ sở dữ liệu SQLite & Drizzle ORM (`src/db/`).
- Backend server runtime, API routes & helpers (`src/server/`, `src/lib/`).
- Hệ thống test suite (`tests/`).
- Thư mục rác, file backup cũ, comment và mã nguồn bị vô hiệu hóa.

### 1.2. Công cụ & Kỹ thuật sử dụng
- **TypeScript Compiler API (`ts.createProgram`):** Có chạy symbol scan heuristic; kết quả cần xem như ứng viên, không phải proof về runtime reachability.
- **Dependency & Import Graph Scraper:** Quét import/text references; chưa bao phủ dynamic import, deployment, external consumer hoặc runtime reflection.
- **Regex & Token Scanner:** Quét commented-out code, TODOs, stale comments (nhắc tới proxy/dual-router/pool cũ).
- **Filesystem & Git Inspector:** Đối chiếu trạng thái đĩa với Git tree để tìm empty directories và stale backup artifacts.

---

## 2. BẢNG KIỂM KÊ DEAD CODE TRONG CODEBASE

### 2.1. Unused UI Components (`src/components/ui/`)
Lượt quét import tĩnh không tìm thấy consumer cho 6 trong 38 UI wrapper; đây là nhóm ứng viên ưu tiên, chưa phải danh sách xóa đã duyệt.

| File | Mô tả | Bước tiếp theo |
| :--- | :--- | :--- |
| `src/components/ui/chart.tsx` | Wrapper Recharts | Xác minh consumer trước khi xóa |
| `src/components/ui/checkbox.tsx` | Wrapper Radix Checkbox | Xác minh consumer trước khi xóa |
| `src/components/ui/context-menu.tsx` | Wrapper Radix Context Menu | Xác minh consumer trước khi xóa |
| `src/components/ui/progress.tsx` | Wrapper Radix Progress | Xác minh consumer trước khi xóa |
| `src/components/ui/scroll-area.tsx` | Wrapper Radix Scroll Area | Xác minh consumer trước khi xóa |
| `src/components/ui/toggle-group.tsx` | Wrapper Radix Toggle Group | Xác minh consumer trước khi xóa |

---

### 2.2. Feature Components mồ côi (Orphaned Components in `src/components/`)
Các component chưa tìm thấy consumer runtime trong lượt quét:

1. **`src/components/metric-card.tsx` (111 dòng):**
   - *Hiện trạng:* Component `MetricCard` dùng motion/react và HaloCard, **0 caller** trên toàn bộ các trang.
   - *Hệ quả:* Giữ lại import `Sparkline`, `Badge`, `HaloCard`.
2. **`src/components/sparkline.tsx` (75 dòng):**
   - *Hiện trạng:* Chỉ duy nhất `metric-card.tsx` import. Không có page nào hiển thị.
3. **`src/components/sidebar.tsx` (1 dòng):**
   - *Nội dung:* `export * from "./app-sidebar";`
   - *Hiện trạng:* Không có bất kỳ file nào import từ `src/components/sidebar`. Tất cả đều import trực tiếp từ `@/components/app-sidebar` hoặc `@/components/ui/sidebar`. Đây là re-export shim rác.
4. **`src/components/ninerouter/mini-usage-card.tsx` (186 dòng):**
   - *Hiện trạng:* Chưa tìm thấy nơi render trong runtime. `tests/repro-ninerouter-modifier.test.ts:3` vẫn import `formatTokens` từ file này; phân loại contract của helper trước khi xóa cả module.

---

### 2.3. Schema, Client & Migrations của Database "Sync" (`src/db/sync/`)
Sau khi hệ thống chuyển sang quản lý tài khoản đơn lẻ và loại bỏ dual-router master sync:
1. **`src/db/sync/schema.ts`:**
   - Khai báo các bảng: `usageEvents`, `usageWrites`, `runReports`, `syncPolicy`.
   - **0 file nào trong runtime import hay ghi vào các bảng này.**
2. **`src/db/sync/client.ts`:**
   - Export hàm `openSyncDb(filePath: string): SyncDbClient`.
   - **0 caller trong toàn bộ `src/`, `tests/`, `scripts/`.**
3. **`src/db/migrations/sync/0000_baseline.sql` & `meta/_journal.json`:**
   - Migration và journal vẫn tồn tại. Backup/restore và deploy còn tham chiếu `router-sync.sqlite3`; không gộp với dọn comment hoặc UI.
4. **`src/db/common/migrate.ts`:**
   - `migrateDomain` vẫn phục vụ DB rotation. Nhánh `sync` cần đánh giá riêng cùng client và hợp đồng backup/deploy.

---

### 2.4. Server Modules & Functions thừa (Dead Server Code)
1. **`src/server/backup/crypto-envelope.ts` (60 dòng):**
   - Export `sealSnapshot` và `openSnapshot` (mã hóa AES-256-GCM).
   - **Không có bất kỳ caller nào trong `backup-service.ts`, `git-sync.ts` hay runtime.** File này chỉ được test bởi `tests/dual-router-crypto.test.ts`. Đây là code chết từ tính năng dual-router crypto cũ.
2. **`src/server/activity-log.ts`:**
   - Export các hàm: `logActivityThrottled`, `setSyncProgress`, `resetSyncProgress`, `getActivitySnapshot`, `clearActivity`.
   - Tất cả 5 hàm này **không có caller nào** trong hệ thống backend hay API route.
   - Type `SyncPhase` vẫn còn chứa phase `"rank" | "activate"` từ thời xếp hạng proxy pool cũ.
3. **`src/server/nine-router-client.ts`:**
   - Export hàm `nineRouterAuthMode`: Không có caller nào.
4. **`src/server/server-interactive-updater.ts`:**
   - Interface `NineRouterInteractiveSshRunner` và runner interactive update: Không được tích hợp vào API hay runtime của `src/`, chỉ được tham chiếu trong test tái hiện lỗi SSH.
5. **`src/lib/api.ts`:**
   - `formatTime`: Utility format thời gian không ai gọi.
   - `rotateAntigravityAccounts`: Hàm gọi `POST /api/antigravity/rotate` không được bất kỳ nút hay component UI nào sử dụng (UI hiện chỉ dùng `refreshAntigravityQuota`).

---

### 2.5. Empty Directories & Stale Artifacts (Thư mục & Dữ liệu rác)
Codebase sau đợt dọn dẹp proxy vẫn để lại các thư mục rỗng và file backup cũ:

- **Thư mục rỗng trên đĩa (14 thư mục):**
  - `src/server/dual-router/`
  - `src/components/dual-router/`
  - `src/db/proxies/`
  - `src/db/migrations/proxies/` & `src/db/migrations/proxies/meta/`
  - `src/app/(dashboard)/ninerouter/dashboard/`
  - `src/app/(dashboard)/ninerouter/proxies/`
  - `src/app/(dashboard)/wallet/`
  - `src/app/(dashboard)/scraping/`
  - `src/app/(dashboard)/reseller/`
  - `src/app/(dashboard)/referral/`
  - `src/app/(dashboard)/invoice/`
  - `src/app/(dashboard)/cdk/`
  - `tests/fixtures/proxy-refresh/`
  - `.agents/skills/telegram-proxy-refresh/scripts/`
- **Backup lịch sử (`backups/`), không thuộc phạm vi xóa:**
  - `backups/databases/proxies.sqlite3` (Cơ sở dữ liệu proxy cũ).
  - `backups/pool-state.json` (State JSON của proxy pool cũ).

---

### 2.6. Test mồ côi & Test "ảo" (Dummy / Detached Tests)
1. **`tests/live-console-terminal.test.ts`:**
   - Kiểm tra một vòng lặp mảng `for (let i = 0; i < 1200; i++) lines.push(...)` thuần túy trong RAM. Component `LiveConsoleTerminal` không hề tồn tại trong dự án!
2. **`tests/mini-usage-card.test.ts`:**
   - Khai báo một hàm `formatTokens` cục bộ ngay trong file test và assert kết quả. Không hề import hay kiểm thử component `MiniUsageCard`.
3. **`tests/dual-router-crypto.test.ts`:**
   - Test `crypto-envelope.ts` – một module vốn dĩ không được sử dụng ở bất kỳ đâu trong ứng dụng.
4. **`tests/repro-ninerouter-modifier.test.ts`:**
   - Chứa test tái hiện lỗi giả lập SSE và Cookie bằng code mock inline, không kiểm tra module thực tế nào ngoài hàm `formatTokens` của component chết `mini-usage-card.tsx`.

---

## 3. PHÂN TÍCH COMMENTS TRONG PROJECT

### 3.1. Thống kê tổng quan
- Thống kê ban đầu đếm theo mẫu dòng, không phải token comment. Bỏ sót JSX, comment inline và các dòng code bị comment như `ease`, `delayChildren`, `staggerChildren` trong `text-animate.tsx`. Không dùng số đếm đó làm tiêu chí hoàn thành.

---

### 3.2. Chi tiết Commented-Out Code (Cần xóa ngay)
1. **`src/components/ui/text-animate.tsx` (dòng 201, 215, 218):**
   ```tsx
   //   const { ref, inView } = useInView({
   ...
   //     if (isInView) {
   ...
   //     if (!isInView) {
   ```
   *Nguyên nhân:* Comment lại hook `useInView` cũ khi chuyển đổi animation logic nhưng không xóa.
2. **`tests/repro-ninerouter-modifier.test.ts` (dòng 24):**
   ```ts
   // if (payload.type === "init" && Array.isArray(payload.logs)) setLogs(payload.logs.slice(-1000))
   ```
   *Nguyên nhân:* Để lại đoạn code triển khai tham khảo dạng comment.

---

### 3.3. Comment lỗi thời gây nhiễu ngữ cảnh (Stale Context Comments)
1. **`src/server/activity-log.ts` (dòng 20–21):**
   ```ts
   // 40 was too small: bulk audit progress (started/periodic/finished) pushed sync
   // entries out within a single run. 200 keeps sync + audit visible together.
   ```
   *Vấn đề:* Nhắc tới tính năng "bulk audit progress" của hệ thống proxy đã bị loại bỏ. Khi Agent đọc file này, Agent dễ suy diễn sai rằng hệ thống vẫn còn luồng proxy audit ngầm.
2. **`tests/settings-ux-validation.test.ts` (dòng 23, 55):**
   ```ts
   // Removed Proxy Export Controls
   ...
   // Removed Proxy Settings
   ```
   *Vấn đề:* Comment đánh dấu việc đã xóa tính năng proxy.

---

### 3.4. Đánh giá các Block Comment khác
Xóa banner UI và JSDoc thuần mô tả theo cùng chính sách. Với bất biến khó suy ra (ví dụ không ghi đè phi nguyên tử khi `rename` thất bại), kiểm tra coverage hiện có; nếu chưa có, ghi một lần trong tài liệu kỹ thuật chuẩn hoặc kiểm chứng bằng test hành vi trước khi bỏ comment.

---

## 4. TẠI SAO AI AGENT BỊ HALLUCINATIONS KHI SỬA CODE? (ROOT CAUSE ANALYSIS)

Hiểu rõ cơ chế gây ra ảo giác (hallucination) của LLM trong kỹ thuật phần mềm:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CƠ CHẾ SINH RA HALLUCINATION                    │
└────────────────────────────────────────────────────────────────────────┘

 1. CONTEXT SMILING & STALE CODE (Nhiễm độc ngữ cảnh)
    Agent đọc thấy `openSyncDb` hoặc comment "proxy audit"
    ──► Agent tưởng tính năng vẫn chạy
    ──► Agent viết thêm code xử lý cho một thứ không còn tồn tại!

 2. PRE-TRAINING BIAS (Khuynh hướng từ dữ liệu huấn luyện)
    Next.js 16 / React 19 trong repo khác với Next.js 14 / React 18 phổ biến
    ──► Agent tự bịa ra hook `useRouter().query` hoặc syntax cũ
    ──► Biên dịch gãy!

 3. SPECULATIVE IMPORTS (Đoán mò hàm / module)
    Thấy cần format ngày ──► Tự `import { formatDate } from "@/lib/utils"`
    Thấy cần icon ──► Tự `import { RobotIcon } from "lucide-react"`
    ──► Module/Icon không tồn tại!

 4. IN-PLACE GUESSING (Sửa mù không đọc Caller Graph)
    Sửa tên cột bảng từ "Gemini Session Quota" thành "Session Quota"
    ──► Không biết có test `dashboard-content-integrity.test.ts` đang assert chuỗi này
    ──► Test gãy!

 5. NO FEEDBACK VERIFICATION (Không chạy lệnh kiểm chứng sau khi sửa)
    Agent tự tin trả lời "Đã sửa xong!" mà không hề chạy `tsc` hay test
    ──► Lỗi syntax/logic lọt vào codebase.
```

### Chi tiết các nguyên nhân gốc rễ:
1. **Context Pollution (Nhiễm độc ngữ cảnh từ Dead Code & Stale Comment):**
   - LLM hoạt động dựa trên phân phối xác suất từ ngữ trong context window. Khi codebase chứa các file chết (`sync/schema.ts`, `metric-card.tsx`) hoặc comment nhắc đến proxy, LLM gán trọng số chú ý (attention weight) cho các khái niệm đó, dẫn tới việc tự bịa ra các cờ cấu hình (flags) hoặc tham số tương thích ngược không hề cần thiết.
2. **Pre-training Prior vs. Local Repository Invariants:**
   - LLM có xu hướng đưa ra giải pháp "phổ biến trên Internet" thay vì giải pháp "đúng với cấu trúc repo hiện tại". Ví dụ: tự thêm package mới thay vì dùng native helper có sẵn; tự viết lại hàm `formatTime` thay vì tái sử dụng helper của project.
3. **Speculative Imports (Nhập khẩu phỏng đoán):**
   - Agent thường ảo giác rằng các hàm tiện ích thông dụng luôn nằm trong `@/lib/utils` (như `formatDate`, `slugify`) hoặc icon nào cũng có trong `lucide-react`.
4. **Vi phạm Boundary & Hợp đồng kiểm thử ngầm:**
   - Lần audit trước, `npm test` thất bại vì `tests/dashboard-content-integrity.test.ts:42` tìm chữ `Gemini Session Quota` trong source, còn heading đang là `Session Quota`. Điều này chứng minh test phụ thuộc chuỗi, không chứng minh UI sai hay ai đã đổi nhãn.
5. **Diff Drift & Hashes Mismatch:**
   - Khi Agent sửa file lớn mà không có neo dòng (anchors / tags), LLM có xu hướng sửa chệch vị trí đóng ngoặc `}` hoặc duplicate code.

---

## 5. GIẢI PHÁP & PROTOCOL CHUẨN: LÀM SAO ĐỂ AGENT KHÔNG HALLUCINATE?

Không có cách bảo đảm agent không hallucinate. Xóa comment làm giảm ngữ cảnh cũ; đọc định nghĩa, dò contract và kiểm chứng hành vi mới giảm lỗi khi sửa.

---

### TRỤ CỘT 1: ZERO POISONED CONTEXT (LÀM SẠCH MÔI TRƯỜNG MÃ NGUỒN)
> *"Context window sạch là vũ khí mạnh nhất chống ảo giác."*

- **Dead code:** Chỉ xóa sau khi đối chiếu tham chiếu tĩnh, entry point framework, cấu hình, deploy và test. Không dùng `0 caller` làm kết luận duy nhất.
- **Commented-out code:** Xóa trong đợt comment-only. Lịch sử Git giữ phiên bản cũ.
- **Comment người viết:** Bỏ theo phạm vi ở đầu báo cáo; giữ thành phần có tác dụng với công cụ, kiểu hoặc hợp đồng phát hành.

---

### TRỤ CỘT 2: GROUNDING-FIRST GATE (BẮT BUỘC KHẢO SÁT THỰC TẾ TRƯỚC KHI GÕ PHÍM)
> *"Không được sửa bất kỳ dòng code nào dựa trên trí nhớ hoặc phỏng đoán."*

Mỗi khi nhận nhiệm vụ, Agent **bắt buộc tuân thủ 3 bước Grounding**:
1. **Kiểm tra phụ thuộc (`package.json`):** Xác định chính xác phiên bản thư viện đang dùng (Next.js 16, Hono 4, Drizzle 0.45, React 19). Tuyệt đối không dùng API của phiên bản khác.
2. **Kiểm tra biểu tượng & Icon thực tế:** Trước khi import một icon từ `lucide-react` hoặc một helper từ `@/lib/utils`, Agent phải dùng `read` hoặc `grep` để chắc chắn symbol đó thực sự tồn tại và xem đúng chữ ký tham số.
3. **Kiểm tra Caller & Contract Test:** Trước khi đổi tên một function, một type, hay một nhãn text hiển thị trên UI, Agent **phải grep toàn bộ codebase** để xem:
   - Những file nào đang gọi symbol này?
   - Có file test nào đang assert text này không?

---

### TRỤ CỘT 3: AUTOMATED TYPE-SYSTEM ENFORCEMENT (DÙNG COMPILER LÀM BỘ LỌC TỰ ĐỘNG)
> *"TypeScript là máy phát hiện ảo giác tối thượng."*

- Mọi thay đổi trong code TypeScript phải được kiểm chứng ngay bằng:
  ```bash
  npm run typecheck   # tương đương: tsc --noEmit
  ```
- `tsc --noEmit` bắt nhiều lỗi type/import, nhưng không chứng minh đúng hành vi, route động, hợp đồng deploy hoặc giao diện render.
- Tiếp theo là linter:
  ```bash
  npm run lint        # tương đương: biome lint src tests scripts
  ```
  Bắt ngay các biến thừa, import không dùng, hoặc cú pháp nguy hiểm.

---

### TRỤ CỘT 4: REPRO & FALSIFICATION LOOP (VÒNG LẶP KIỂM CHỨNG THỰC TẾ)
> *"Mọi sửa đổi phải có bằng chứng thực thi, không chấp nhận khẳng định suông."*

1. **Trước khi sửa bug:** Chạy test hoặc tạo một repro script nhỏ chứng minh bug đang tồn tại.
2. **Sau khi sửa bug:** Chạy lại đúng test đó để chứng minh bug đã hết và không gây ra regression:
   ```bash
   node --import tsx --test <test-file>
   ```
3. **Nếu test fail:** Không được đoán mò hay suy diễn. Đọc trực tiếp dòng lỗi (`AssertionError`, stack trace), quay lại kiểm tra file mã nguồn và sửa dứt điểm.

---

## 6. QUY TRÌNH 5 BƯỚC CHUẨN HÓA CHO AGENT (AGENT WORKFLOW PROTOCOL)

Khi giao nhiệm vụ sửa đổi cho bất kỳ AI Agent nào, đưa trực tiếp checklist này vào System Instructions:

```
┌────────────────────────────────────────────────────────────────────────┐
│              QUY TRÌNH 5 BƯỚC CHỐNG HALLUCINATION CHO AGENT            │
├────────────────────────────────────────────────────────────────────────┤
│ Bước 1: READ & ANCHOR (Đọc và lấy neo)                                 │
│   - Đọc kỹ file mục tiêu bằng công cụ `read`.                          │
│   - Không bao giờ đoán cấu trúc code từ trí nhớ.                       │
│                                                                        │
│ Bước 2: TRACE REFERENCES (Dò vết tham chiếu)                           │
│   - Grep tên hàm/biến/component muốn sửa trên toàn bộ dự án.           │
│   - Xác định toàn bộ caller và các test liên quan.                     │
│                                                                        │
│ Bước 3: SURGICAL EDIT (Sửa phẫu thuật tối thiểu)                       │
│   - Dùng công cụ `edit` với hash anchor chính xác.                     │
│   - Chỉ sửa đúng các dòng cần thiết; không format lại code xung quanh.  │
│   - Tuân thủ nguyên tắc Ponytail/YAGNI: Không thêm abstraction thừa.   │
│                                                                        │
│ Bước 4: 3-TIER VERIFICATION (Bộ ba kiểm chứng bắt buộc)                 │
│   1. Chạy `npm run typecheck` (tsc --noEmit).                          │
│   2. Chạy `npm run lint` (biome lint).                                 │
│   3. Chạy test suite mục tiêu: `node --import tsx --test <test-path>`. │
│                                                                        │
│ Bước 5: CONFIRM & REPORT (Báo cáo dựa trên bằng chứng)                │
│   - Chỉ tuyên bố hoàn thành khi cả 3 bước kiểm chứng đều pass (exit 0).│
│   - Nêu rõ bằng chứng kiểm tra, không nói chung chung.                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. BỘ QUY TẮC MẪU (COPY-PASTE VÀO `AGENTS.MD` HOẶC `RULE.MD`)

Có thể lưu nội dung sau vào file hướng dẫn cấu hình của dự án (ví dụ `.cursor/rules/anti-hallucination.md` hoặc `AGENTS.md`) để mọi Agent tự động tuân thủ:

```markdown
# AGENT ANTI-HALLUCINATION RULES

1. Grounding Invariant:
   - NEVER assume an import, helper, icon, or type exists.
   - ALWAYS read the target file and grep imports before writing code.
   - Check `package.json` for real installed versions before proposing patterns.

2. Contract Safety:
   - Before renaming or altering any exported function, type, or UI label, grep for all occurrences across `src/` and `tests/`.
   - Modifying a tested surface requires updating or verifying its contract test.

3. Zero Guesswork Diffing:
   - NEVER overwrite entire files when modifying a single function.
   - Use anchored diffs (`edit` tool) with exact matching context lines.

4. Mandatory 3-Step Verification Gate:
   After EVERY edit turn, execute in order:
   a) `npm run typecheck` -> Must exit with 0 errors.
   b) `npm run lint` -> Must exit with 0 errors.
   c) Target test command -> Must pass deterministically.
   If any command fails, DO NOT report completion. Diagnose and fix the root cause immediately.
```

---

## 8. KẾT LUẬN & ACTION ITEMS TIẾP THEO CHO DỰ ÁN

1. **Dọn comment trước.** Tách patch riêng, không đổi logic, nhãn UI hay assertion. Giữ directive, license bắt buộc, file generated/vendor và migration đã phát hành.
2. **Dọn dead code dễ xác minh sau.** Ưu tiên 6 UI wrapper, re-export `src/components/sidebar.tsx`, và cặp `MetricCard`/`Sparkline`. Xác minh reference và entry point trước khi xóa. `MiniUsageCard` có test dùng helper; test tự chép logic như `live-console-terminal.test.ts` không chứng minh hành vi production.
3. **Đánh giá riêng DB và vận hành.** Sync DB, backup, updater và module test-only cần đối chiếu deployment, CLI, restore hoặc consumer ngoài repo. Không xóa dữ liệu theo grep.
4. **Không sửa UI để làm xanh test chuỗi.** Lỗi quota ở trên đã có trước cleanup. Xác nhận nhãn theo contract sản phẩm; nếu cần test, kiểm tra UI render và tên truy cập được, không dò source.
5. **Quy tắc agent:** Đọc định nghĩa, lần caller và entry point, kiểm tra version đã resolve khi dùng API thư viện, sửa nhỏ và chạy check đúng hành vi. Nếu chỉ có heuristic, báo là ứng viên; nếu chưa chạy check, ghi chưa kiểm chứng.
