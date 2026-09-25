# Контракт API (фронт ↔ бэкенд)

Фронт знает только один адрес — `config.json → api.baseUrl` — и шлёт туда все запросы.
Сейчас этот адрес — webhook n8n, позже — сервис в Docker. Пока оба реализуют этот контракт,
фронт при переезде не меняется (меняется только `api.baseUrl`).

## Транспорт

```
POST {api.baseUrl}
Content-Type: application/json
Authorization: Bearer <sessionToken>     # для всех action, кроме auth.start / auth.verify

{ "action": "<имя>", "payload": { ... } }
```

Ответ — всегда JSON:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "INVALID_CODE", "message": "Неверный код", "retryAfterSec": 0 } }
```

HTTP-статусы: `200` — успех, `400` — ошибка данных, `401` — нет/истекла сессия
(фронт сразу показывает экран входа), `403` — нет прав, `404` — не найдено, `429` — лимит.

Бэкенд обязан отдавать CORS-заголовки для домена фронта
(`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Content-Type, Authorization`) и отвечать на `OPTIONS`.

## Секреты

Ключ бота Pyrus (`PYRUS_LOGIN`, `PYRUS_SECURITY_KEY`), ключи Mango Office (`MANGO_API_KEY`, `MANGO_API_SALT`)
и секрет для хэширования кодов (`AUTH_CODE_SECRET`) живут **только на бэкенде**:
в credentials n8n сейчас, в `.env` контейнера потом. Во фронт и в git они не попадают.

---

## auth.start — запросить код

Вход: `{ provider: "mango", identifierType: "phone" | "email", identifier: "79001234567" }`

Бэкенд:
1. Находит сотрудника в Pyrus (`GET /v4/members`) по телефону/email. Нет — `404 NOT_FOUND`.
2. Проверяет лимит: не чаще 1 раза в `resendTimerSec` (60 с) → иначе `429 RATE_LIMITED` + `retryAfterSec`.
3. Генерирует 6-значный код, хранит **только хэш** (HMAC-SHA256 с `AUTH_CODE_SECRET`), TTL 5–10 мин, 5 попыток.
4. Отправляет код через провайдера (для `mango` — см. ниже).

Выход: `{ challengeId: "ch_...", ttlSec: 300 }`

## auth.verify — проверить код, выдать сессию

Вход: `{ provider, identifierType, identifier, challengeId, code }`

Ошибки: `INVALID_CODE` (попытки уменьшаются), `CODE_EXPIRED`, `LOCKED`.

Успех — бэкенд создаёт сессию (случайный токен, TTL 7 дней, хранится на бэкенде) и возвращает:

```json
{
  "sessionToken": "…",
  "user": { "id": 123, "name": "Петров Иван", "login": "79001234567" },
  "roles": [1329637],
  "permissions": { "ALL": "view", "TP": "edit", "PO": "view" }
}
```

`roles` — id ролей сотрудника в Pyrus (`GET /v4/members/{id}` → `roles`).
`permissions` — необязательно; если не передать, фронт посчитает права сам по `config.lines[].editRoles`.
Но **проверять права при сохранении обязан бэкенд** (см. schedule.save).

## auth.me — проверить сессию

Вход: `{}`. Выход: как у `auth.verify`, без `sessionToken`. Нет сессии — `401`.

## auth.logout

Вход: `{}`. Удаляет сессию. Выход: `{}`.

## pyrus.request — чтение из Pyrus

Вход: `{ path: "/v4/forms/2470373/register", method: "GET" }`

Бэкенд подставляет токен бота Pyrus и возвращает ответ Pyrus как есть.
Разрешены **только** `GET` и **только** пути из белого списка:

| Путь | Зачем |
|---|---|
| `/v4/members` | сотрудники |
| `/v4/members/{id}` | роли сотрудника |
| `/v4/catalogs/309671` | справочник «Смены работы» |
| `/v4/catalogs/309670` | справочник «Подразделения компании» |
| `/v4/forms/2470373/register` | реестр «График работы» |
| `/v4/forms/2470368/register` | реестр «График отпусков» |

Всё остальное — `403 FORBIDDEN_PATH`. Без белого списка любой, кто знает адрес хука,
сможет вызвать любой метод Pyrus от имени бота.

## schedule.save — сохранить изменения смен

Вход:

```json
{
  "changes": {
    "create":  { "task": [ { "employee_id": 1, "item_id": 800001, "start": "2026-09-15T05:00:00.000Z",
                             "duration": 540, "amount": 3000, "department_item_id": 900001 } ] },
    "edit":    { "task": [ { "task_id": 555, "employee_id": 1, "item_id": 800001, "start": "…",
                             "duration": 540, "amount": 3000, "department_item_id": 900001 } ] },
    "deleted": { "task": [ { "task_id": 556 } ] }
  },
  "meta": { "line": "TP", "month": 9, "year": 2026 }
}
```

Бэкенд:
1. По сессии берёт роли пользователя и проверяет, что он редактор подразделения `department_item_id`
   (ТП → роль `1329637`, ПО → `1329638`). Иначе — `403`.
2. Для `edit`/`deleted` проверяет, что задача из формы `2470373` и её подразделение совпадает.
3. Создаёт/меняет задачи формы «График работы» (`2470373`):

| field_id | Поле | Значение |
|---|---|---|
| 1 | Подразделения компании | `{ "item_id": department_item_id }` |
| 2 | Сотрудник | `{ "id": employee_id }` |
| 3 | Дата и время смены | `start` (UTC ISO), `duration` (минуты) |
| 4 | Деньги | `amount` |
| 5 | Смены компании | `{ "item_id": item_id }` |

   Создание: `POST /v4/tasks` с `form_id: 2470373` и `fields`.
   Изменение: `POST /v4/tasks/{task_id}/comments` с `field_updates`.
   Удаление: `DELETE /v4/tasks/{task_id}` (или закрытие задачи — как принято в компании).

Выход: `{ created: 1, edited: 0, deleted: 0 }`

## vacation.create — добавить отпуск

Вход: `{ "employee_id": 1, "start_date": "2026-09-11", "days": 3, "line": "TP" }`

Бэкенд:
1. Проверяет, что пользователь — редактор вкладки `line` (как в schedule.save). Иначе — `403`.
2. `days` — от 1 до 90, `start_date` — `YYYY-MM-DD`.
3. `choice_id` отдела берёт из описания формы (`GET /v4/forms/2470368`, поле 4) по названию вкладки (ТП/ПО).
4. Создаёт задачу формы «График отпусков» (`2470368`), период — как его создаёт сам Pyrus:

| field_id | Поле | Значение |
|---|---|---|
| 1 | Отпускной период | `"{start_date}T00:00:00Z"`, `duration` = (days − 1) × 1440 (для 1 дня — без duration) |
| 2 | За какой год отпуск | год из `start_date` |
| 3 | Отпускник | `{ "id": employee_id }` |
| 4 | Отдел | `{ "choice_ids": [choice_id] }` |
| 5 | Кол-во дней отпуска | `days` |

Выход: `{ task: { …задача из ответа Pyrus… } }` — фронт показывает её сразу (реестр обновляется с задержкой).

Проверку «в периоде нет смен» делает фронт (по загруженному графику).

## vacation.delete — удалить отпуск

Вход: `{ "task_id": 381098672 }`

Бэкенд проверяет, что задача из формы `2470368` и её «Отдел» — вкладка, где пользователь редактор. Иначе — `403`.
Удаление: `DELETE /v4/tasks/{task_id}`. Выход: `{ deletedId: 381098672 }`

Код узла «API» воркфлоу n8n с этими действиями — `docs/n8n-api-node.js`.

---

## Провайдер входа `mango` (черновик — уточнить)

Предполагаемая схема: код приходит по SMS через Mango Office.

- Запрос: `POST https://app.mango-office.ru/vpbx/commands/sms`
  с полями формы `vpbx_api_key`, `sign`, `json`.
- `sign = sha256(vpbx_api_key + json + vpbx_api_salt)`.
- `json`: `{ "command_id": "<uuid>", "from_extension": "<внутренний номер-отправитель>",
  "to_number": "79001234567", "text": "Код входа: 123456", "sms_sender": "<имя отправителя>" }`.

Альтернативы, если SMS не подходит: звонок-сброс (код = последние цифры номера) или подтверждение
по внутреннему номеру сотрудника в Mango. Выбор провайдера не меняет фронт: он всегда вызывает
`auth.start` → `auth.verify`.
