# Resin 언어 명세 (v0.2 초안)

Resin 은 ER 다이어그램만 그리는 작은 언어다. 스키마의 사실(널 허용, 키, 참조, 인덱스, 암호화,
감사 테이블)을 **문자열 규칙이 아니라 문법으로** 적는다. 지금은 Mermaid `erDiagram` 으로
컴파일해 그린다.

이 문서가 문법의 정본이다. 구현(`src/`)과 이 문서가 다르면 구현이 틀린 것이다.

## 1. 한눈에 보기

```erd
%% 주문 도메인
external table users "svc_accounts 회원" {
  id  bigint  pk
}

table ts_order "주문" {
  id          bigint       pk
  user_id     bigint       ~> users  "주문자"  index as idx_user_id
  order_no    varchar(32)  uk as uk_order_no  "주문번호"
  buyer_name  varchar?     enc  "주문자명"
  status      varchar      enum(PENDING, PAID, CANCELED)  index as idx_status
  created_at  datetime
  updated_at  datetime
} audit envers(user_id, status)

table ts_order_item "주문 항목" {
  id          bigint  pk
  order_id    bigint  -> ts_order.id  index as ix_order_id
  product_id  bigint  "상품 ID"
  quantity    int
  created_at  datetime
  unique(order_id, product_id) as uk_order_product
}
```

## 2. 어휘

| 요소 | 형태 | 비고 |
|---|---|---|
| 식별자 | `[A-Za-z_][A-Za-z0-9_]*` | 테이블, 컬럼, 타입, 이름, enum 값 |
| 백틱 식별자 | `` `...` `` | 백틱과 줄바꿈을 뺀 아무 글자. 하이픈, 공백, 한글 이름용. 키워드로 읽히지 않는다 |
| 수 | `[0-9]+` | 타입 인자와 enum 값에만 쓴다 |
| 문자열 | `"..."` | 이스케이프는 `\"` `\\` 두 가지. 한 줄 안에서 끝나야 한다 |
| 주석 | `%%` 부터 줄 끝까지 | mermaid 와 같다 |
| 기호 | `{ } ( ) , . ?` | |
| 참조 화살표 | `->` `~>` | 물리 FK / 논리 참조 |
| 줄바꿈 | `\n` | **문장 구분자다.** 괄호 `( )` 안에서는 무시한다 |

키워드(`table` `external` `pk` `uk` `enc` `enum` `index` `unique` `as` `audit`)는 **문맥 키워드**다.
예약어가 아니라서 `index` 라는 이름의 컬럼도 쓸 수 있고, 자리로 구분한다. 백틱으로 감싼 이름은
어느 자리에서도 키워드가 아니다. `` `users` `` 와 `users` 는 같은 이름이다.

## 3. 문법 (EBNF)

```ebnf
document    = { NL | table } EOF ;
table       = [ "external" ] "table" name [ STRING ] "{" { member | NL } "}" [ audit ] ( NL | EOF ) ;
member      = constraint | column ;

column      = name type { modifier } ( NL | "}" ) ;   (* "}" 는 소비하지 않는다 — 한 줄 테이블용 *)
type        = IDENT [ "(" NUMBER { "," NUMBER } ")" ] [ "?" ] ;
modifier    = "pk" | "enc"
            | "uk" [ "as" name ]
            | "index" [ "as" name ]
            | "enum" values
            | ( "->" | "~>" ) name [ "." name ]
            | STRING ;

constraint  = ( "unique" | "index" ) list [ "as" name ] ;  (* 키워드 바로 뒤가 "(" 일 때만 제약 *)
audit       = "audit" IDENT [ list ] ;
list        = "(" [ name { "," name } [ "," ] ] ")" ;
values      = "(" [ value { "," value } [ "," ] ] ")" ;
value       = name | NUMBER ;
name        = IDENT | QUOTED ;
```

## 4. 의미

### 4.1 테이블

- `table 이름 ["설명"] { ... }` — 이름은 문서 안에서 유일하다(`external table` 까지 통틀어).
  설명은 사람이 읽을 말이다.
- `external table 이름 ["설명"] { ... }` — **이 문서 밖**(다른 서비스, 다른 DB)에 있는 테이블이다.
  가리키는 데 필요한 컬럼만 적는다(보통 기본키 하나). 다른 테이블처럼 참조를 받고 검사된다.
  external table 의 컬럼에는 참조(`->`, `~>`)를 적을 수 없고, `audit` 을 붙일 수 없다.

### 4.2 컬럼

`이름 타입[?] 수식어...` — SQL DDL 과 같은 순서(이름 먼저)다.

- **타입**은 물리 타입 이름에 인자를 붙일 수 있다: `bigint`, `varchar(32)`, `decimal(12,2)`.
  인자는 적힌 그대로 싣고, 적지 않아도 된다.
- **`?`** 는 널 허용이다(`varchar?`, `varchar(32)?`). `?` 가 없으면 NOT NULL 이라는 **적극적 주장**이다.
- 수식어는 순서가 자유롭다. 같은 수식어를 두 번 쓰면 오류다.

| 수식어 | 뜻 |
|---|---|
| `pk` | 기본키. 여러 컬럼에 붙이면 복합 기본키. 널 허용(`?`)과 함께 쓸 수 없다 |
| `uk` / `uk as 이름` | 단일 컬럼 UNIQUE |
| `enc` | 암호화되어 저장된다 |
| `enum(A, B)` | 값 후보. 이름이나 수(`enum(0, 1, 2)`). 스키마나 코멘트가 뒷받침하는 값만 적는다 |
| `index` / `index as 이름` | 이 컬럼이 첫 컬럼인 인덱스. 이름을 모르면 `as` 없이 |
| `-> t.c` | 물리 FK (DB 에 `FOREIGN KEY` 제약이 있다) |
| `~> t.c` | 논리 참조 (앱이 참조로 쓰지만 DB 제약은 없다) |
| `"..."` | 사람이 읽을 설명. **설명에는 사실을 넣지 않는다** — 위 수식어로 적을 수 있는 건 수식어로 |

### 4.3 참조와 카디널리티

- 참조는 **컬럼에 붙는다.** 관계선을 따로 쓰지 않는다.
- `.c` 를 생략하면 대상 테이블의 기본키를 가리킨다. 기본키가 한 컬럼이 아니면 오류다.
- 대상은 같은 문서의 `table` 이나 `external table` 이어야 한다.
- **몇 대 몇인가**는 참조 컬럼의 유일성으로 정한다. 참조 컬럼에 `uk` 가 있거나 그 컬럼이
  테이블의 유일한 기본키면 1:1, 아니면 1:N.
- **부모가 꼭 있는가**는 참조 컬럼의 널 허용으로 정한다. NOT NULL 이면 자식마다 부모가 정확히 하나,
  `?` 면 없거나 하나.
- 대상 컬럼과 타입 이름이 다르면 경고한다. 타입 인자(길이)는 비교하지 않는다.

### 4.4 이름 (`as`)

인덱스와 유니크 제약의 이름은 `as` 뒤에 적는다. 괄호에는 늘 목록만 들어간다.

- 컬럼: `uk as uk_order_no`, `index as idx_user_id`
- 테이블 제약: `unique(a, b) as uk_ab`, `index(a, b) as ix_ab`

같은 테이블 안에서 이름이 겹치면 오류다.

### 4.5 테이블 제약

테이블 블록 안의 한 줄로 적는다. 키워드 바로 뒤에 `(` 가 와야 제약이다(`index int` 는 컬럼이다).

- `unique(a, b)` / `unique(a, b) as 이름` — 복합 UNIQUE
- `index(a, b)` / `index(a, b) as 이름` — 복합 인덱스

단일 컬럼이면 컬럼 수식어(`uk`, `index`)를 쓴다. 한 컬럼짜리 제약은 경고한다.

### 4.6 감사 테이블 (`audit`)

감사 테이블을 한 줄로 선언한다. `audit` 뒤에 **방식**을 적는다. 지금 있는 방식은 `envers`
(Hibernate Envers) 하나다.

- `} audit envers(c1, c2)` — `<table>_aud` 에 기본키, `rev`, `revtype`, 그리고 적은 컬럼만 싣는다.
- `} audit envers` — 기본키와 `created_at`, `updated_at` 을 뺀 모든 컬럼을 싣는다.
- 한 테이블이라도 `audit envers` 가 있으면 `revinfo` 테이블과 관계선이 자동으로 생긴다.
  그래서 `revinfo` 나 `<table>_aud` 라는 이름을 직접 선언하면 충돌 오류다.
- 기본키가 없는 테이블과 external table 에는 쓸 수 없다.

## 5. Mermaid 로의 대응 (컴파일 규칙)

| Resin | Mermaid `erDiagram` |
|---|---|
| `table t "설명"` | `t["t (설명)"] { ... }` — 설명이 없으면 `t { ... }` |
| `external table u` | 블록 줄에 `:::external`, 맨 끝에 `classDef external stroke-dasharray:4 3` |
| `a_id bigint -> a.id` (in `b`) | `a \|\|--o{ b : "a_id"` + 속성 `bigint a_id FK "-> a.id"` |
| `~>` | 점선 `..` |
| 참조가 1:1 | 오른쪽 `o\|` |
| 참조 컬럼이 `?` | 왼쪽 `\|o` |
| 타입 | 적힌 그대로: `varchar(32)?` |
| `pk` `uk` 참조 | 키 마커 `PK` `UK` `FK` (순서 PK, FK, UK) |
| 설명, `enc`, `enum` | 속성 코멘트: `"설명 (enc) A/B"` |
| 참조 대상 | 그 뒤에 `; -> a.id` |
| `index` / `index as n`, `uk as n` | 코멘트 끝에 `(ix)` / `(n)` |
| `unique(a, b)` / `unique(a, b) as n` | 첫 컬럼 코멘트에 `uk(a,b)` / `n(a,b)` |
| `index(a, b)` / `index(a, b) as n` | 첫 컬럼 코멘트에 `ix(a,b)` / `n(a,b)` |
| `audit envers` | `revinfo` 블록 + `<table>_aud` 블록 + `revinfo \|\|..o{ <table>_aud : "Envers rev"` |

### 5.1 이름 옮기기

mermaid 는 일부 이름을 그대로 읽지 못한다(11.16 에서 확인).

- **테이블 이름**이 영문, 숫자, `_` 로만 되어 있지 않거나 mermaid 예약어(`class` `classDef`
  `style` `erDiagram` `direction` `accTitle` `accDescr` `title` `to` `one` `many`, 대소문자 무시)면
  `"..."` 로 감싼다.
- **컬럼 이름**은 mermaid 에서 따옴표를 쓸 수 없다. 글자, 숫자, `_`, `-` 밖의 글자는 `_` 로 바꾸고,
  숫자나 `-` 로 시작하면 앞에 `_` 를, `pk` `fk` `uk`(대소문자 무시)와 같으면 뒤에 `_` 를 붙인다.
  이름을 바꿨으면 코멘트 맨 앞에 원래 이름을 `` `...` `` 로 적는다.
- 문자열 안의 `"` 는 `#quot;` 로 바꾼다. mermaid 는 `\"` 를 모른다.

### 5.2 출력 순서

`erDiagram` → 범례 주석(참조가 있을 때) → 도메인 관계선(자식 테이블, 컬럼의 문서 순서) → 빈 줄 →
감사 관계선 → 엔티티 블록(문서 순서, external 포함) → `revinfo` → `*_aud` → `classDef`.
같은 입력이면 바이트 단위로 같은 출력이 나온다.

## 6. 진단

모든 오류와 경고는 `줄:열` 위치를 가진다. 파서는 오류가 난 줄을 건너뛰고 계속 읽어서
**한 번에 여러 오류를 보고한다.** 구문 오류가 있으면 의미 검사를 하지 않고(가짜 오류를 막으려고),
오류가 하나라도 있으면 컴파일(mermaid 출력)은 하지 않는다.

## 7. v0.1 에서 옮기기

v0.1 문법을 만나면 파서가 오류와 함께 고치는 법을 알려 준다.

| v0.1 | v0.2 |
|---|---|
| 첫 줄 `erd` | 지운다 |
| `index(idx_name)` | `index as idx_name` |
| `unique name(a, b)` / `index name(a, b)` | `unique(a, b) as name` / `index(a, b) as name` |
| `} audit(a, b)` / `} audit` | `} audit envers(a, b)` / `} audit envers` |
| 문서 밖 참조를 설명 문자열로 | `external table` 을 선언하고 `~>` |
