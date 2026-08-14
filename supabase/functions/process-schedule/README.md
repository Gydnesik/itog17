# process-schedule

Edge Function принимает фото расписания от администратора, отправляет его в Gemini и возвращает нормализованные расписания.

Особенно важная нормализация классов:

- `8а`
- `8А`
- `8 а`
- `8 А`
- `8-а`
- `8A`

→ всё становится `8А`.

Если один класс распознан несколько раз, уроки объединяются, сортируются по дню/номеру и одинаковые строки удаляются.

## Secrets

В Supabase:

```bash
supabase secrets set GEMINI_API_KEY="YOUR_GEMINI_KEY" GEMINI_MODEL="gemini-3.6-flash"
```

`GEMINI_API_KEY` хранится только на стороне Edge Function.

## Deploy

```bash
supabase link --project-ref igbkjkjagkhxpxezjwtj
supabase functions deploy process-schedule --project-ref igbkjkjagkhxpxezjwtj
```
