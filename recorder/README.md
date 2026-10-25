# 숏츠 편집기 ↔ 녹음기 연결

## 작업 모드 (편집기 위쪽 버튼)

| 모드 | 화면 | 쓰는 때 |
|---|---|---|
| **편집만** | 편집기만 | 녹음 없이 TTS로 만들 때, 꾸미기·내보내기만 할 때 |
| **같이 쓰기** | 편집기 오른쪽에 녹음기가 붙음 | 문장을 보며 녹음 → 바로 장면에 들어가는 것 확인 |
| **녹음만** | 녹음기를 따로 창으로 | 녹음에 집중할 때, 모니터 두 대를 쓸 때 |

- 연결되면 편집기 위쪽에 **● 녹음기 연결됨**이 떠요.
- 편집기에서 대본을 고치면 녹음기 문장 목록도 바로 바뀌어요.
- 한쪽에서 장면을 고르면 다른 쪽도 같은 문장으로 따라가요.
- 녹음기에서 녹음을 마치면 그 장면에 자동으로 들어가요. 기존 "녹음 파일 넣기"(파일 이름 순서)도 그대로 쓸 수 있어요.
- 「편집만」으로 바꿔도 따로 열린 녹음기 창은 닫지 않아요. 녹음 중일 수 있어서, 그 창에서 오는 녹음은 계속 받아요.

## 주소 (GitHub 페이지)

- 편집기: https://hyun1592-sinsu.github.io/shorts-editor/
- 녹음기: https://hyun1592-sinsu.github.io/shorts-editor/recorder/

녹음기는 편집기 저장소의 `recorder/` 폴더에 있어요. 지금 들어 있는 것은 **예시 녹음기**입니다. 내 녹음 대시보드 파일을 이 폴더에 넣으면 그대로 연결돼요. 다른 주소의 녹음기를 쓰려면 편집기 위쪽 **녹음기 ⚙**에서 바꾸세요.

## 내 녹음기에 붙이는 법 (3줄)

1. 녹음 대시보드 파일을 `recorder/` 폴더에 넣어요. `recorder-bridge.js`는 이미 들어 있어요.
2. 녹음기 `index.html` 맨 아래에 추가해요.
   ```html
   <script src="recorder-bridge.js"></script>
   ```
3. 녹음기 코드에서 필요한 곳에 연결해요.
   ```js
   // 편집기 문장 목록 받기 (바뀔 때마다 다시 불림)
   ShortsBridge.onScript(({ scenes }) => {
     // scenes: [{ id, no, text, silent, voice }]
     // silent=true는 나레이션 없는 장면, voice가 있으면 이미 녹음된 장면
   });

   // 녹음이 끝났을 때 (blob = 녹음 파일)
   if (ShortsBridge.connected) await ShortsBridge.sendVoice(no, blob, '03_문장.wav');
   else /* 원래처럼 파일로 저장 */;
   ```
   선택 동기화가 필요하면 `ShortsBridge.onSelect(...)`와 `ShortsBridge.select(no)`를 쓰세요.

예시는 `recorder/index.html`(예시 녹음기)을 보면 돼요. 내 대시보드의 첫 화면 파일 이름이 `index.html`이어야 기본 주소로 열려요.

## 주고받는 메시지 (개발용)

모든 메시지에는 `sv: 1`이 붙어요. 편집기는 **자기가 연 창**(같이 쓰기 칸, 녹음만 창)이 보낸 메시지만 받아요.

| 방향 | type | 내용 |
|---|---|---|
| 녹음기 → 편집기 | `hello` | 연결 시작. 편집기가 `script`로 답함 |
| 녹음기 → 편집기 | `get-script` | 장면 목록 다시 받기 |
| 녹음기 → 편집기 | `select` | `id` 또는 `no`(1부터) |
| 녹음기 → 편집기 | `voice` | `id`/`no`, `name`, `mime`, `data`(Blob/ArrayBuffer), `ref` |
| 편집기 → 녹음기 | `script` | `title`, `selectedId`, `scenes[]` |
| 편집기 → 녹음기 | `select` | `id`, `no` |
| 편집기 → 녹음기 | `voice-ok` / `voice-error` | `ref`, `id`, `no`, `dur` / `reason` |

## 주의

- 마이크: 「같이 쓰기」 칸 안에서도 녹음되도록 `allow="microphone"`을 넣어 두었어요. 처음 한 번은 브라우저가 마이크 허용을 물어봐요.
- **편집기와 녹음기는 같은 주소(hyun1592-sinsu.github.io)라서 브라우저 저장소를 함께 써요.** 녹음기가 IndexedDB나 localStorage를 쓴다면 이름이 `shorts-editor`, `shorts-rec-…`와 겹치지 않게 해 주세요.
- 브라우저 저장소는 **그 PC, 그 브라우저**에만 남아요. 다른 PC에서 열면 비어 있어요.
- **녹음 파일(내 목소리)은 GitHub 저장소에 올리지 마세요.** 공개 저장소는 누구나 받아 갈 수 있어서, 목소리 복제나 사칭에 쓰일 수 있어요. `.gitignore`가 mp4·webm 등을 이미 막고 있지만, wav·mp3도 막도록 추가해 두었어요.
