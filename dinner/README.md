# Ужин из продуктов дома

`model.js` — чистый количественный расчёт; `queue.js` — сохраняемый запрос/повтор/разрешение после
выхода; `ui.js` и `style.css` — экран; `catalog.json` — четыре рецепта с измеримым составом и явным
вариантом. `../supabase/migrations/20261103062758_dinner_batch.sql` — подготовленный серверный контракт.
Новых зависимостей нет. Продолжение PR5 интегрировано с принятым Nutrition Stage2, не открывает AI.

## Модель и единицы

- `amount({value,unit})` → `{value,dimension}` либо null. Вход: десятичная строка/число до трёх знаков;
  единицы g/kg, ml/l, целые pcs. Результат: целые тысячные г/мл/шт. BigInt только внутри; JSON-выход обычный.
  Штуки/масса/объём не смешиваются. Непредставимые порции дают clarify, overflow покупок — ошибку.
- `evaluateMenu({meals,lots,profiles,ingredients,householdId})` распределяет подтверждённые пригодные
  партии FEFO по датам/id и уменьшает копию остатка. Планы/исходные запасы не меняются.
- `suggest` вычисляет до трёх независимых альтернатив, не три одновременно доступных ужина.
- Статусы enough/buy/clarify: достаточно / точный дефицит / количество, мера, состав или срок нужно
  уточнить. Истёкшие/нулевые партии не покрывают потребность, морозилка не исключение.
- `shopping(result)` — desired demand, не запись в корзину. Только точные дефициты разрешённого меню.
  `formatAmount(190000,'mass')` → `190 г`.
- `Recipe`: id/version/basePortions, полный ingredients с ingredientId и quantity, allowedModes, steps.
  Замена — полный другой вариант с собственным составом/количествами/шагами. В fixtures нет выпускаемого
  медицинского меню. BF-режим пока не размечен и честно получает пустой результат.
- `Lot`: id/householdId/ingredientId, quantity {value,unit,source}, expiresOn/dateSource,
  dinner_version/version и excludedFromDinner. Источники measured/user и label/user подтверждены;
  legacy_unknown/catalog defaults/примерная дата требуют уточнения. Исключение партии явно обратимо,
  не удостоверяет её состав и не удаляет её из холодильника.

`adaptInventory({rows,householdId,confirmed:true})` понимает DB и scoped camelCase-поля. Null/zero не
подменяются fallback. Подтверждённый snapshot — обязанность caller; флаг сам не доказывает запись.
`adaptProfiles` в UI обязательно получает `userId`; принимает только owner-bound минимальную проекцию
со stock_scope_id текущих запасов. Это клиентская проверка контекста, не замена серверной авторизации.
Generic family-scoped режим модели без userId сохранён для чистых данных/совместимости PR5, в приватном
UI он не используется. На сервере владельцем никогда не считается created_by/членство семьи.

## Gates и приватность

По умолчанию нет client opt-in (`SF_ENABLE_DINNER=1`), dinner_release_control.enabled=false и
profile_privacy_accepted=false. Общий stock_release_control также останавливает новые записи.
Новая RPC не создаёт owner-колонку, не backfill-ит legacy и не применяет review/profile-privacy.sql.
Его известные lifecycle/anonymous blockers остаются зависимостью ответственного за выпуск.

Snapshot не возвращает личные профили при privacy hold. После отдельного принятия — только свои
подтверждённые взрослые профили: id, имя, режим, исключения, actor/stock scope. Нет веса/роста/возраста,
замеров, цели, baby_age или данных другого взрослого. Отсутствующая owner-колонка даёт закрытый доступ.
Shared household относится к запасам, не к личным ограничениям. Передача чужих профилей не реализована.
Новые profile forms не переоткрываются. Неподтверждённые ограничения текущей сессии блокируют расчёт.

При выходе DOM/память очищаются, личный ввод очереди удаляется; сохраняется opaque operation ID.
При обычной перезагрузке без выхода прежний точный запрос сохраняется. При повторном входе resolve
под той же блокировкой подтверждает существующую квитанцию либо создаёт cancellation tombstone:
поздний исходный запрос не сможет записаться после ответа «не сохранено». Старые ответы отбрасываются
по scope и epoch, включая logout/login того же аккаунта. Backup opaque ID позволяет удалить личный
payload при quota. Очистка всех данных сайта удаляет и эти локальные ID — нужна сверка журнала/остатков.

## RPC

`sb.rpc('dinner_mutate',{op_id,hh_id,kind,body})`:

| kind | body / результат |
|---|---|
| snapshot | op_id=null, body={}; партии, покупки, stats, минимальные own profiles, profile_access_ready, scope revisions, 20 событий, локальный день Asia/Almaty |
| confirm_lot | id/expected_version/ingredient_id/qty_num/unit/expires_on; явное подтверждение партии, снимает её исключение |
| exclude_lot | id/expected_version/excluded; исключить/вернуть без изменения количества/срока/идентификации |
| shopping | profiles/meals/desired/scope_id/expected_scope_revision; серверный перерасчёт, атомарная замена только своего generated вклада |
| buy | id/expected/expires_on; атомарный перенос покупки с сохранением identity/quantity provenance |
| consume | profiles/meals:[meal]/deltas:[{id,expected_version,amount}]; общий commit партий, статистики, журнала и квитанции |
| undo | operation_id своего consume; сначала проверка всех партий, затем общее восстановление + reversal |
| resolve | op_id прежнего действия, body={}; ack уже сохранённого либо cancellation tombstone для ещё не записанного |

profiles = [{id,mode,exclusions}] — точный снимок только своего подтверждённого профиля.
meal = {id,recipe_id,recipe_version,day:'YYYY-MM-DD',portions}; desired = ingredientId → дефицит в тысячных
канонической единицы; delta.amount — фактическое количество в исходной единице партии. Ограничения:
до 21 приёма в покупках, 50 партий расхода, 1–100 порций, 30 собственных профилей.

Все mutations требуют stock/dinner gates; новые consume/shopping дополнительно требуют принятой
приватности и подтверждённого взрослого владельца. Anonymous Auth отвергается. Уже сохранённое действие
можно разрешить/отменить без чтения профиля. Snapshot при privacy hold не отдаёт личные данные.

Привилегированная реализация закрыта в sf_private с пустым search_path и явными проверками; публичная
RPC SECURITY INVOKER. Квитанции/версии scopes/control закрыты и с RLS; dinner_events читают только члены
семьи и не могут писать напрямую. Пакет не заменяется клиентским циклом stock_mutate. После ожидания
общей блокировки перепроверяется членство; профили и все версии партий проверяются до подтверждения.
Любая ошибка откатывает весь пакет. Повтор UUID с другим payload отклоняется. Отмена не удаляет исходный
журнал, не перезаписывает поздние изменения; статистика не выдумывает массу штук/миллилитров.

Недельная кнопка явно повторяет выбранное блюдо семь раз. Scope revision защищает от старого плана
другого устройства; ручные покупки не удаляются. План/шаги/cancel до отправки ничего не списывают и
не означают еду съеденной. Старый nutrition path остаётся закрытым; его profile/AI safeguards сохранены.

## Проверки

```sh
npm ci
npm test
SUPABASE_URL=https://fixture.supabase.test SUPABASE_ANON_KEY=sb_publishable_fixture npm run build
npm run test:browser
npm run test:privacy-browser
npm run test:http
npm run test:dinner:http
```

Для HTTP: одноразовая PostgreSQL на 127.0.0.1 с именем sf_stock_test_*, SF_TEST_DATABASE_URL и абсолютный
SF_TEST_POSTGREST_BIN; при необходимости SF_TEST_POSTGREST_LIBRARY_PATH/CHROME_PATH. Новый HTTP suite
создаёт/удаляет отдельную случайную БД. Auth issuance/user/logout — fixtures; JWT/PostgREST/RLS/SQL
настоящие. Profile privacy review candidate и синтетические владельцы включены только в test helper,
не в продуктовую migration. Это не managed Auth/pg_advisors/physical-device acceptance.

Точные результаты, не принятые зависимости и передача: `../SF-DINNER-INTEGRATION.md`.

## Дополнение к «Мои данные»

`../review/dinner-my-data.sql` — отдельный review-кандидат: собственный экспорт dinner-действий
и очистка исходного запроса при удалении его подтверждённого профиля. UUID/undo/общий запас сохраняются.
Выпускной My Data UI должен послать `sf:personal-data-deleting` до запроса удаления, а затем
обновить snapshot; dinner очищает личный ввод и разрешает незавершённое по opaque ID. Сам UI Stage3
здесь не включён. Контракт, границы удаления и порядок приёмки —
`../SF-DINNER-PERSONAL-DATA-REVIEW.md`. Полный набор: 192 теста, 14 групп dinner HTTP, включая
три явно обозначенных review-проверки. Product migration/helper этот кандидат автоматически не ставят.
