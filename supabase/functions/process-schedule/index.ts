import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!
const geminiKey = Deno.env.get('GEMINI_API_KEY')!
const geminiModel = Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash'

const DAY_ORDER = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье']
const LATIN_TO_CYR = new Map([
  ['A','А'],['B','В'],['C','С'],['E','Е'],['H','Н'],['K','К'],['M','М'],['O','О'],['P','Р'],['T','Т'],['X','Х'],['Y','У'],
])

function normalizeClassName(value: unknown): string | null {
  let s = String(value ?? '').trim().toUpperCase()
  s = s.replace(/\bКЛАСС\b/giu, '').replace(/[\s._\-–—:№]+/g, '')
  for (const [latin, cyr] of LATIN_TO_CYR) s = s.replaceAll(latin, cyr)
  const match = s.match(/^(5|6|7|8|9|10|11)([АБВГ])$/u)
  return match ? `${match[1]}${match[2]}` : null
}

function normalizeDay(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е')
  const aliases: Record<string, string> = {
    'пн':'Понедельник','пон':'Понедельник','понедельник':'Понедельник',
    'вт':'Вторник','вторник':'Вторник',
    'ср':'Среда','среда':'Среда',
    'чт':'Четверг','четверг':'Четверг',
    'пт':'Пятница','пятница':'Пятница',
    'сб':'Суббота','суббота':'Суббота',
    'вс':'Воскресенье','воскресенье':'Воскресенье',
  }
  return aliases[raw] || String(value ?? '').trim() || 'Понедельник'
}

function normalizeLesson(raw: any, fallbackIndex: number): any | null {
  if (!raw || typeof raw !== 'object') return null
  const subject = String(raw.subject ?? raw.name ?? raw.title ?? '').trim()
  if (!subject) return null
  const lessonRaw = Number(raw.lesson ?? raw.number ?? fallbackIndex + 1)
  const lesson = Number.isFinite(lessonRaw) && lessonRaw > 0 ? Math.floor(lessonRaw) : fallbackIndex + 1
  return {
    day: normalizeDay(raw.day),
    lesson,
    subject,
    time: String(raw.time ?? '').trim(),
    room: String(raw.room ?? raw.cabinet ?? raw.classroom ?? '').trim(),
  }
}

function normalizeLessons(raw: unknown): any[] {
  if (!Array.isArray(raw)) return []
  const result: any[] = []
  raw.forEach((item, i) => {
    const lesson = normalizeLesson(item, i)
    if (lesson) result.push(lesson)
  })
  result.sort((a,b) => {
    const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day)
    return d || a.lesson - b.lesson || a.subject.localeCompare(b.subject, 'ru')
  })
  const seen = new Set<string>()
  return result.filter(x => {
    const key = `${x.day}|${x.lesson}|${x.subject}|${x.time}|${x.room}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeSchedules(input: any) {
  const out: Record<string, any[]> = {}
  const ignoredClasses: string[] = []
  const source = Array.isArray(input?.schedules)
    ? input.schedules
    : input?.schedules && typeof input.schedules === 'object'
      ? Object.entries(input.schedules).map(([class_name, lessons]) => ({ class_name, lessons }))
      : Array.isArray(input)
        ? input
        : []

  for (const item of source) {
    const rawClass = item?.class_name ?? item?.className ?? item?.class ?? item?.name
    const className = normalizeClassName(rawClass)
    if (!className) {
      if (String(rawClass ?? '').trim()) ignoredClasses.push(String(rawClass).trim())
      continue
    }
    const lessons = normalizeLessons(item?.lessons)
    if (!out[className]) out[className] = []
    out[className].push(...lessons)
  }

  for (const className of Object.keys(out)) out[className] = normalizeLessons(out[className])
  return { schedules: out, ignoredClasses: [...new Set(ignoredClasses)] }
}

const responseSchema = {
  type: 'object',
  properties: {
    schedules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          class_name: { type: 'string' },
          lessons: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'string' },
                lesson: { type: 'integer' },
                subject: { type: 'string' },
                time: { type: 'string' },
                room: { type: 'string' },
              },
              required: ['day','lesson','subject','time','room'],
            },
          },
        },
        required: ['class_name','lessons'],
      },
    },
  },
  required: ['schedules'],
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    if (!geminiKey) return json({ error: 'На сервере не задан GEMINI_API_KEY.' }, 500)

    const auth = req.headers.get('Authorization') || ''
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: auth } },
    })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return json({ error: 'Необходим вход в аккаунт.' }, 401)

    const { data: profile, error: profileError } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()
    if (profileError || profile?.role !== 'admin') return json({ error: 'Доступ только для администратора.' }, 403)

    const body = await req.json()
    const image = String(body.image || '')
    const mimeType = String(body.mimeType || 'image/jpeg').split(';')[0]
    if (!image) return json({ error: 'Фото не передано.' }, 400)
    if (!mimeType.startsWith('image/')) return json({ error: 'Поддерживаются только изображения.' }, 400)
    if (image.length > 15_000_000) return json({ error: 'Фото слишком большое. Выбери изображение поменьше.' }, 413)

    const prompt = `Ты — очень строгий OCR-парсер школьного расписания на русском языке. На фото может быть одна большая таблица, где классы являются заголовками столбцов, а дни/номера уроков — строками. Твоя задача — не "понять примерно", а восстановить таблицу максимально буквально.

ПРАВИЛО №1 — НИЧЕГО НЕ ПРОПУСКАЙ:
- Просмотри изображение целиком, включая левый/правый края, верхние заголовки и нижние строки.
- Обрабатывай КАЖДЫЙ видимый столбец класса и КАЖДУЮ непустую ячейку.
- Если один и тот же класс встречается в нескольких местах, собери все его уроки.
- Если день указан один раз над блоком строк, протяни этот день на весь блок до следующего дня.
- lesson — фактический номер урока из таблицы, а не индекс массива.
- Не удаляй строку только потому, что текст кажется странным.

ПРАВИЛО №2 — КЛАССЫ:
- Поддерживаются классы 5А–11Г.
- "8а", "8А", "8 а", "8 А", "8-а", "8A" = строго "8А".
- "8B" = "8В" (латинская B визуально часто заменяет кириллическую В).
- "8Б" НЕ превращай в "8В".
- Различай Б и В по форме символа; если заголовок явно показывает Б — сохраняй Б.
- Используй только кириллицу: А, Б, В, Г.
- Не придумывай букву класса, если её реально нельзя определить.

ПРАВИЛО №3 — УРОКИ:
- Каждый урок: day, lesson, subject, time, room.
- Если время или кабинет отсутствуют/не видны, ставь пустую строку.
- Не придумывай предметы, время или кабинеты.
- Сохраняй сокращения предметов, если они напечатаны именно так.
- Не смешивай соседние ячейки разных классов.
- Если в ячейке два предмета через перенос строки/дробь и это реально одна ячейка, сохрани оба в subject, а не выдумывай второй урок.
- Не считай пустую ячейку уроком.

ПРАВИЛО №4 — ОБЪЕДИНЁННЫЕ ЯЧЕЙКИ (нет границы между столбцами классов):
- Иногда между двумя (или более) соседними столбцами классов на конкретной строке НЕТ вертикальной линии-разделителя — это значит, что ячейка объединена сразу на несколько классов, а не что там просто пусто у одного из них.
- Такая объединённая ячейка может занимать не одну строку, а сразу несколько строк подряд (то есть отсутствует разделение и по вертикали между классами, и по горизонтали между соседними номерами уроков) — сверху и снизу.
- В этом случае НЕЛЬЗЯ пытаться угадать и разделить текст ячейки между классами по смыслу. Нужно взять ПОЛНЫЙ, ЦЕЛИКОМ текст этой ячейки (включая все части через "/") и записать его ОДИНАКОВО, без сокращений, в subject КАЖДОГО класса, которого касается эта объединённая ячейка.
- Если объединение растянуто на несколько строк подряд, повтори эту логику отдельно для каждой такой строки: для каждой строки, накрытой объединением, у всех затронутых классов должна получиться своя lesson-запись (со своим номером урока) с одинаковым полным текстом subject для этой строки. Текст на разных строках объединения может отличаться — тогда просто копируешь то, что реально написано в этой строке, но одинаково во все накрытые ею классы.
- Пример: если между столбцами "10А" и "10Б" на строке урока №6 нет разделителя и написано "104мат у/ 307мат у/", то у 10А появляется lesson №6 с subject "104мат у/ 307мат у/", и у 10Б тоже появляется lesson №6 с точно таким же subject "104мат у/ 307мат у/" — а не так, что 10А получает "104мат у", а 10Б — "307мат у".
- Ищи такие места отдельно для КАЖДОЙ пары/группы соседних классов на КАЖДОЙ строке — не только там, где это кажется очевидным, а по всей таблице.

ПРАВИЛО №5 — ВИЗУАЛЬНАЯ ПРОВЕРКА:
1) Сначала найди ВСЕ заголовки классов.
2) Затем найди строки дней и номеров уроков, ВКЛЮЧАЯ самые нижние строки таблицы (номера уроков 6, 7, 8, 9) — таблицы школьного расписания почти всегда доходят минимум до 6-7 урока, и именно нижние строки чаще всего теряются при распознавании. Явно проверь каждую строку снизу вверх отдельно.
3) Потом прочитай каждую клетку на пересечении класса и строки.
4) На каждой строке отдельно проверь, есть ли вертикальная граница между КАЖДОЙ парой соседних столбцов классов. Если границы нет — это объединённая ячейка, применяй Правило №4.
5) После первичного чтения мысленно пройди таблицу второй раз слева направо и сверху вниз и проверь, что ни один класс/урок не потерян, отдельно сверяя именно нижнюю часть таблицы и объединённые ячейки.
6) Для каждого класса посчитай, сколько непустых/объединённых ячеек у него в столбце, и убедись, что итоговое количество lessons для этого класса равно этому числу.

Верни только JSON по заданной схеме.`

    async function callGemini(textPrompt: string) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: textPrompt },
            { inline_data: { mime_type: mimeType, data: image } },
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`)
      let raw = ''
      for (const p of data?.candidates?.[0]?.content?.parts || []) if (p.text) raw += p.text
      raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
      if (!raw) throw new Error('Gemini не вернул JSON.')
      try { return JSON.parse(raw) } catch { throw new Error('Gemini вернул невалидный JSON.') }
    }

    let firstPass: any
    try {
      firstPass = await callGemini(prompt)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }

    // Второй проход получает исходное фото снова: модель не доверяет своему первому OCR,
    // а сверяет его с таблицей и исправляет пропущенные/смешанные классы и ячейки.
    let verified = firstPass
    try {
      const draft = JSON.stringify(firstPass)
      const verifyPrompt = `Ты — контроль качества OCR школьного расписания. У тебя есть исходное фото таблицы и черновой JSON, полученный первым проходом.

ТВОЯ ЗАДАЧА — ПЕРЕПРОВЕРИТЬ ЧЕРНОВОЙ JSON ПО ИСХОДНОМУ ФОТО, А НЕ ПРОСТО ПОВТОРИТЬ ЕГО.

Проверь:
1. Все ли классы на фото присутствуют в JSON.
2. Все ли строки уроков каждого класса присутствуют.
3. Не перепутаны ли соседние столбцы классов.
4. Не потеряны ли первые/последние уроки и правый/левый край таблицы.
5. Правильно ли перенесены дни на строки блока.
6. Правильно ли указан номер урока.
6б. ОСОБОЕ ВНИМАНИЕ нижним строкам таблицы (уроки 6, 7, 8, 9) — в черновике их чаще всего не хватает. Проверь их отдельно и добавь всё, что реально видно на фото.
7. Не перепутаны ли 8Б и 8В.
8. Нормализуй варианты класса: 8а/8А/8 а/8 А/8-а/8A -> 8А; 8B -> 8В.
9. Если в черновике есть предмет, которого на фото нет, удали его. Если на фото есть предмет, которого нет в черновике, добавь его.
10. Не выдумывай невидимый текст. Если время/кабинет не читается — пустая строка.
11. ОБЪЕДИНЁННЫЕ ЯЧЕЙКИ (без границы между столбцами классов): для каждой строки проверь, нет ли на фото пропущенной вертикальной линии между соседними классами. Если есть строка, где текст ячейки в черновике записан только у одного класса, а на фото видно, что граница со столбцом соседнего класса на этой строке отсутствует (ячейка на самом деле объединена на два и более класса, возможно на несколько строк подряд сразу) — исправь черновик так, чтобы у ВСЕХ затронутых классов на этой строке (и на каждой строке, которую покрывает объединение) был ОДИНАКОВЫЙ ПОЛНЫЙ текст subject, без разделения по смыслу между классами.

Очень важно: верни ПОЛНЫЙ исправленный JSON, а не список изменений. Даже если черновик кажется правильным, заново сверь таблицу.

ЧЕРНОВОЙ JSON:
${draft}

Верни только JSON по заданной схеме.`
      verified = await callGemini(verifyPrompt)
    } catch (_) {
      // Если контрольный проход временно недоступен, безопасно используем первый валидный проход.
      verified = firstPass
    }

    const parsed = verified
    const normalized = normalizeSchedules(parsed)
    const entries = Object.entries(normalized.schedules)
    if (!entries.length) return json({ error: 'Не удалось распознать ни одного поддерживаемого класса (5А–11Г).', ignoredClasses: normalized.ignoredClasses }, 422)

    return json({ schedules: normalized.schedules, ignoredClasses: normalized.ignoredClasses, model: geminiModel })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
