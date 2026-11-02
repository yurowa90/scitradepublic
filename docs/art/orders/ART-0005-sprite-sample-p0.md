# ART-0005 원래 설계 업무 스프라이트 견본 — P0 동료 6종 (허브 작성, 2026-11-01)
- layer: pixel
- kind: sprite-draft
- use: 사용자 요청 "원래 설계일 때 스프라이트 보여줘". 원래 설계(ART_DIRECTION ‘미술 지침’, PIXEL_SPEC 2절)의 32×32 SD 업무 스프라이트 모습을 보여 주는 견본이다. 승인 자산이 아니라 ② 픽셀 초안이다.
- size: 생성 3:2 한 장에 6종을 2줄×3칸으로 배치 → 칸별로 잘라 tools/art/pixelize.py로 32×32 공용 팔레트 맞춤 → 화면 배율 3(96 px) 견본
- palette: src/assets/palette.json (scitrade-32)
- variants: 2
- reference_grammar: 2.5~3등신 SD 동물·신수, 둥근 외곽, 크게 읽히는 얼굴, 종 특징 1~2개 + 업무 소품 1개, 1 px 어두운 외곽선, 2~3단 평면 음영. data/characters.json visual_motif 그대로.
- prompt: |
    Pixel art character sheet, 16-bit era office management game style, six separate small chibi animal coworkers arranged in a 2 by 3 grid with wide empty space between them,
    each about 2.5 heads tall, round soft silhouette, big readable cute face, 1-pixel dark navy outline, flat shading with 2 to 3 tones, limited soft pastel palette, crisp pixels, no anti-aliasing,
    plain flat cream background (#fbf6ec), each character standing in a neutral idle pose facing slightly to the side, holding one small work prop.
    Top row left to right: (1) a fennec fox with huge ears, cream and light copper fur, a folded mint scarf, holding a small sales clipboard;
    (2) a chubby river otter in a round waterproof work vest with a shell-shaped buckle, holding a cargo tag;
    (3) a round-cheeked flying squirrel with a tan body and light green gliding membranes, carrying a tiny mail-bag style document case.
    Bottom row left to right: (4) a mythical black tortoise: a round dark teal baby turtle whose shell is divided like cargo compartments, with a small snake companion wrapped around the shell wearing a tiny sorting tag;
    (5) a round red panda with short bangs and an orange-tipped tail, holding a folding product sample board, small tool pouch;
    (6) a haechi (Korean mythical guardian lion-dog) with one tiny horn on the forehead, curly mane, light grey body with navy trim, holding a magnifying glass for checking ledgers, wearing a night-shift apron.
    Cute, friendly, readable at very small size. Absolutely no text, letters or numbers.
- negative: text, letters, numbers, logo, watermark, signature, Japanese, anime, ukiyo-e, realistic, 3d render, gradient, blur, dithering noise, weapon, armor, frame, border, ui, busy background
- after: pixelize
- acceptance: |
    (견본) 6종이 서로 떨어져 있어 칸별로 자를 수 있다. 종 특징·소품이 data/characters.json visual_motif와 맞는다. 글자 없음.
    (변환) 32×32, 공용 팔레트, 불투명 15색 이하, 알파 0/255 — check_pixel_asset.py portrait/work 기준은 승인 단계에서. 이 주문은 견본이라 사람 보정 없이 사용자 확인용으로만 쓴다.
