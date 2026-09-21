# arc-uniques/1 — легендарные 1-of-1 (P01–P18)

> Решение владельца 2026-09-20: **все 18** цельных эскизов художника (дроп `arc-gold-rare-v2`)
> идут в коллекцию как **уникаты**, ровно **по 1 копии**, спрятанные в **скрытых token id**.
> Сатоши (P11) — в общем пуле. Контракт не меняется: вся механика — офчейн-рендер.

## Состав (18 шт., 1254², цельные сцены)
| Категория | Коды | Имена (draft, ждут утверждения) |
|---|---|---|
| People (10) | P01–P10 | The Visionary · The Builder · The Analyst · The Thinker · The Operator · The Dreamer · The Mentor · The Diplomat · The Principal · The Optimist |
| Mythic (8) | P11–P18 | Satoshi · Specter · Zombie · Phantom · Black Cat · Unicorn · Cosmic Entity · Cipherpunk |

Канон ассетов: `art/v2/uniques/<slug>.png`; публичный реестр: `art/v2/uniques/registry.json`
(+ копии: `web/public|lib`, `domain_fork/public|lib` — держать синхронными, проверяет
`check_uniques.py`). Источник импорта — `art/arc-traits/handoff-2026-09-20/rare-concepts/concepts/`.

## Механика
1. **Скрытые id.** 18 номеров: по одному из каждого из 18 окон пространства 1…15 042
   (12 окон по 836 + 6 по 835) — стратифицировано. `piece[i]` живёт по адресу `ids[i]`.
   Id карт последовательные (`++totalMinted` для минта и клейма; форж — 10 000 000+,
   уникаты там не размещаются). Кто получит какой номер — непредсказуемо.
2. **Commit-reveal.** `commitment = sha256(canonical_json({domain, ids[18], salt}))`
   (ключи отсортированы, без пробелов). Публикуется **до** старта мейннета —
   `ops/uniques/COMMITMENT.txt` (репо + GitBook + X). Раскрытие (ids+salt) — когда
   найдены все 18 или коллекция распродана; верификация кем угодно:
   `python3 art/v2/uniques/gen_ids.py --check-reveal "<ids>" <salt>`.
3. **Маскировка до минта.** Рендер-роуты применяют уникат ТОЛЬКО после успешного
   ончейн-чтения токена: `/api/image|meta` для неминутого id отдают обычную карту
   (или preview/404) — прощупать скрытый список запросами невозможно.
   Секрет — только server env `UNIQUES_IDS` (не NEXT_PUBLIC, в клиентский бандл не попадает).
4. **Момент раскрытия.** Как только уникат заминчен — карта сразу рендерится цельным
   полотном; страница `/token/<id>` показывает бейдж «Unique 1-of-1 · <имя>».
   Анонс количества (18) публичен, номера — нет.
5. **Метадата** (минимальная, маркетплейсы): `attributes = [Set: Unique, Piece: <имя>,
   Class: People|Mythic]`, `unique: true`; 15 seed-трейтов не показываются
   (полотно заменяет сборку). `rarity/2` для уникатов не считается.
6. **Особенности.** Уникат может лечь на free-claim карту (claim-сид зависит от
   отправителя, но механика чисто по id; залоченный до wave≥5 трансфер — см. контракт).
   Форж-дети уникатами не бывают. MCP-инструменты секрет не видят — там трейты
   seed-деривации (документировано в описании tools).

## Файлы и инструменты
| Путь | Что |
|---|---|
| `registry.json` | 18 pieces: code/slug/name/category/file/sha256/canvas |
| `import_uniques.py` | импорт ассетов из handoff + сборка реестра + копии в web/и форк (`--write`) |
| `gen_ids.py` | жеребьёвка 18 id (стратификация) + salt, запечатывание, commitment, env (`--write`); `--verify`; `--reveal`; `--check-reveal` |
| `check_uniques.py` | полный гейт: реестр/ассеты/копии/печать/env/leak-guard |
| `ops/uniques/ids.local.json` | СЕКРЕТ (0600, gitignored) — ids+salt |
| `ops/uniques/COMMITMENT.txt` | публичный якорь честности |
| `web/lib/uniques.ts` + `renderer_uniques.ts` | серверный резолвер id→piece + рендер (display 1254 / master 3762×3 nearest) |
| `web/scripts/render-unique-smoke.mjs` | `npm run render:uniques` |

## Ранбук деплоя (когда владелец скажет «го»)
1. `python3 art/v2/uniques/check_uniques.py` — всё зелёное.
2. Опубликовать `ops/uniques/COMMITMENT.txt` (GitBook + X + репо — при публикации).
3. Vercel env (оба проекта: `proofofarchitect-web`, `proofofarchitect`): `UNIQUES_IDS=<из ops/uniques/ids.local.json>` (sensitive).
4. Деплой сайтов; смоук: уникат-страница на тестнете (ids не публиковать!).
5. Мейннет: контракт деплоится как обычно — уникаты включаются автоматически с первым минтом
   (env уже стоит). Ревил — после всех 18 находок: `gen_ids.py --reveal` + `--check-reveal` публично.
