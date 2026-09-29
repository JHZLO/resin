# Resin 언어 명세 (v0.1 초안)

Resin 은 ER 다이어그램만 그리는 작은 언어다. 스키마의 사실(널 허용, 키, 참조, 인덱스, 암호화,
감사 테이블)을 **문자열 규칙이 아니라 문법으로** 적는다. 지금은 Mermaid `erDiagram` 으로
컴파일해 그린다.

이 문서가 문법의 정본이다. 구현(`src/`)과 이 문서가 다르면 구현이 틀린 것이다.

## 1. 한눈에 보기

```erd
erd
  %% 주문 도메인
  table ts_order "주문" {
    id          bigint    pk
    user_id     bigint    "주문자 ID"   index(idx_user_id)
    order_no    varchar   uk            "주문번호"
    buyer_name  varchar?  enc           "주문자명"
    status      varchar   enum(PENDING, PAID, CANCELED)  index(idx_status)
    created_at  datetime
    updated_at  datetime
  } audit(user_id, status)

  table ts_order_item {
    id          bigint  pk
    order_id    bigint  -> ts_order.id  index(ix_order_id)
    quantity    int
    created_at  datetime
  }
```

## 2. 어휘

| 요소 | 형태 | 비고 |
|---|---|---|
| 식별자 | `[A-Za-z_][A-Za-z0-9_]*` | 테이블, 컬럼, 타입, 인덱스 이름, enum 값 |
| 문자열 | `"..."` | 이스케이프는 `\"` `\\` 두 가지. 한 줄 안에서 끝나야 한다 |
| 주석 | `%%` 부터 줄 끝까지 | mermaid 와 같다 |
| 기호 | `{ } ( ) , . ?` | |
| 참조 화살표 | `->` `~>` | 물리 FK / 논리 참조 |
| 줄바꿈 | `\n` | **문장 구분자다.** 괄호 `( )` 안에서는 무시한다 |

키워드(`erd` `table` `pk` `uk` `enc` `enum` `index` `unique` `audit`)는 **문맥 키워드**다 —
예약어가 아니라서 `index` 라는 이름의 컬럼도 쓸 수 있다. 자리로 구분한다.

## 3. 문법 (EBNF)

```ebnf
document    = { NL } "erd" NL { statement } EOF ;
statement   = table | NL ;

table       = "table" IDENT [ STRING ] "{" { member | NL } "}" [ audit ] ( NL | EOF ) ;
member      = constraint | column ;

column      = IDENT type { modifier } ( NL | "}" ) ;   (* "}" 는 소비하지 않는다 — 한 줄 테이블용 *)
type        = IDENT [ "?" ] ;
modifier    = "pk" | "uk" | "enc"
            | "enum" list
            | "index" [ "(" IDENT ")" ]
            | ( "->" | "~>" ) IDENT [ "." IDENT ]
            | STRING ;

constraint  = ( "unique" | "index" ) [ IDENT ] list ;  (* 뒤에 "(" 가 와야 제약으로 읽는다 *)
audit       = "audit" [ list ] ;
list        = "(" [ IDENT { "," IDENT } [ "," ] ] ")" ;
```

## 4. 의미

### 4.1 컬럼

`이름 타입[?] 수식어...` — SQL DDL 과 같은 순서(이름 먼저)다.

- **타입**은 길이, 정밀도 없는 물리 타입 한 토큰이다: `bigint` `varchar` `datetime` `decimal` ...
- **`?`** 는 널 허용이다. `?` 가 없으면 NOT NULL 이라는 **적극적 주장**이다.
- 수식어는 순서가 자유롭다. 같은 수식어를 두 번 쓰면 오류다.

| 수식어 | 뜻 |
|---|---|
| `pk` | 기본키. 여러 컬럼에 붙이면 복합 기본키. 널 허용(`?`)과 함께 쓸 수 없다 |
| `uk` | 단일 컬럼 UNIQUE |
| `enc` | 암호화되어 저장된다 |
| `enum(A, B)` | 값 후보. 스키마나 코멘트가 뒷받침하는 값만 적는다 |
| `index` / `index(name)` | 이 컬럼이 첫 컬럼인 인덱스. 이름을 모르면 괄호 없이 |
| `-> t.c` | 물리 FK (DB 에 `FOREIGN KEY` 제약이 있다) |
| `~> t.c` | 논리 참조 (앱이 참조로 쓰지만 DB 제약은 없다) |
| `"..."` | 사람이 읽을 설명. **설명에는 사실을 넣지 않는다** — 위 수식어로 적을 수 있는 건 수식어로 |

### 4.2 참조와 카디널리티

- 참조는 **컬럼에 붙는다.** 관계선을 따로 쓰지 않는다.
- `.c` 를 생략하면 대상 테이블의 기본키를 가리킨다. 기본키가 한 컬럼이 아니면 오류다.
- 대상 테이블은 **같은 문서 안에** 있어야 한다. 문서 밖(다른 서비스의 사용자 ID 등)을 가리키는
  컬럼은 화살표 없이 설명으로 적는다.
- 카디널리티는 자동으로 정한다: 참조 컬럼에 `uk` 가 있으면 1:1, 없으면 1:N.
- 대상 컬럼과 타입이 다르면 경고한다.

### 4.3 테이블 제약

테이블 블록 안의 한 줄로 적는다.

- `unique(a, b)` / `unique uk_name(a, b)` — 복합 UNIQUE
- `index(a, b)` / `index ix_name(a, b)` — 복합 인덱스

단일 컬럼이면 컬럼 수식어(`uk`, `index`)를 쓴다.

### 4.4 감사 테이블 (`audit`)

Hibernate Envers 감사 테이블을 한 줄로 선언한다.

- `} audit(c1, c2)` — `<table>_aud` 에 기본키, `rev`, `revtype`, 그리고 적은 컬럼만 싣는다.
- `} audit` — 기본키와 `created_at`, `updated_at` 을 뺀 모든 컬럼을 싣는다.
- 한 테이블이라도 `audit` 이 있으면 `revinfo` 테이블과 관계선이 자동으로 생긴다.
  그래서 `revinfo` 나 `<table>_aud` 라는 이름을 직접 선언하면 충돌 오류다.
- 기본키가 없는 테이블에는 `audit` 을 쓸 수 없다.

## 5. Mermaid 로의 대응 (컴파일 규칙)

| Resin | Mermaid `erDiagram` |
|---|---|
| `a_id bigint -> a.id` (in `b`) | `a \|\|--o{ b : "a_id"` + 속성 `bigint a_id FK "-> a.id"` |
| `~>` | 점선 `..` |
| 참조 컬럼에 `uk` | 오른쪽 카디널리티 `o\|` (1:1) |
| `varchar?` | `varchar?` (타입 뒤 `?` 그대로) |
| `pk` `uk` 참조 | 키 마커 `PK` `UK` `FK` (순서 PK, FK, UK) |
| 설명, `enc`, `enum`, `index` | 속성 코멘트: `"설명 (enc) A/B (idx_name)"` |
| 참조 대상 | 설명 뒤에 `; -> a.id`, 인덱스는 그 뒤: `"설명; -> a.id (ix_a_id)"` |
| `unique(a, b)` / `index ix(a, b)` | 첫 컬럼 코멘트에 `uk(a,b)` / `ix(a,b)` |
| `audit` | `revinfo` 블록 + `<table>_aud` 블록 + `revinfo \|\|..o{ <table>_aud : "Envers rev"` |
| 테이블 라벨 `"주문"` | (아직 출력하지 않는다) |

출력 순서: `erDiagram` → 범례 주석(참조가 있을 때) → 도메인 관계선 → 빈 줄 → 감사 관계선 →
엔티티 블록(문서 순서) → `revinfo` → `*_aud`. 같은 입력이면 바이트 단위로 같은 출력이 나온다.

## 6. 진단

모든 오류와 경고는 `줄:열` 위치를 가진다. 파서는 오류가 난 줄을 건너뛰고 계속 읽어서
**한 번에 여러 오류를 보고한다.** 오류가 하나라도 있으면 컴파일(mermaid 출력)은 하지 않는다.
