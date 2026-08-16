import type { PassportExtractionResult } from './types'

const EXTRACTION_PROMPT = `أنت محرك تحليل وثائق رسمية متخصص في قراءة جوازات السفر (من جميع الدول العربية والأجنبية).

مهمتك: تحليل الصورة المرفقة والتحقق أولاً هل هي فعلاً صفحة بيانات جواز سفر (البيانات الشخصية / MRZ) وهل الصورة واضحة بما يكفي لقراءة موثوقة.

القواعد الصارمة:
1. إذا لم تكن الصورة جواز سفر إطلاقاً (مثلاً بطاقة هوية، صورة عشوائية، مستند آخر) اجعل is_passport = false.
2. إذا كانت الصورة جواز سفر لكنها غير واضحة (ضبابية، مقطوعة، بها انعكاس ضوء يحجب النص، مائلة جداً، دقة منخفضة) بحيث لا يمكنك قراءة الاسم أو رقم الجواز بثقة، اجعل is_clear = false واشرح السبب في clarity_reason بالعربي.
3. لا تخمّن أبداً. إذا لم تكن متأكداً من حرف أو رقم، اترك الحقل فارغاً بدلاً من التخمين.
4. استخرج الاسم الكامل بالعربية إن وجد على الجواز (بعض الجوازات العربية تكتب الاسم بالعربي والإنجليزي معاً). إذا لم يوجد اسم عربي مطبوع على الجواز، حاول ترجمة/كتابة الاسم الإنجليزي بأحرف عربية صحيحة النطق في full_name_ar، لكن ضع confidence أقل في هذه الحالة.
5. استخدم منطقة القراءة الآلية MRZ (السطرين السفليين) للتحقق من رقم الجواز وتاريخ الميلاد وتاريخ الانتهاء والجنسية والتأكد من تطابقها مع البيانات المطبوعة أعلى الصفحة. إذا تعارضت البيانات المطبوعة مع MRZ اعتمد على الأكثر وضوحاً واذكر ذلك في clarity_reason.
6. أعد التاريخ بصيغة YYYY-MM-DD دائماً إن أمكن.
7. قيمة confidence رقم بين 0 و 1 يعكس مدى ثقتك الإجمالية في دقة البيانات المستخرجة.

أعد الإجابة بصيغة JSON فقط بدون أي نص إضافي، وفق هذا الشكل بالضبط:
{
  "is_passport": boolean,
  "is_clear": boolean,
  "clarity_reason": "سبب عدم الوضوح إن وجد، أو نص فارغ",
  "full_name_ar": "الاسم الكامل بالعربية",
  "full_name_en": "الاسم الكامل بالإنجليزية كما هو مطبوع",
  "passport_number": "رقم الجواز",
  "nationality": "الجنسية",
  "date_of_birth": "YYYY-MM-DD",
  "date_of_expiry": "YYYY-MM-DD",
  "gender": "ذكر أو أنثى",
  "confidence": 0.0
}`

export async function extractPassportData(
  apiKey: string,
  imageBase64: string,
  mimeType: string
): Promise<PassportExtractionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

  const body = {
    contents: [
      {
        parts: [
          { text: EXTRACTION_PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Gemini API error (${resp.status}): ${errText}`)
  }

  const data = await resp.json<any>()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error('لم يتم استلام رد صالح من Gemini')
  }

  let parsed: PassportExtractionResult
  try {
    parsed = JSON.parse(text)
  } catch {
    // Try to salvage JSON embedded in extra text
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('تعذر تحليل رد Gemini كـ JSON')
    parsed = JSON.parse(match[0])
  }

  return parsed
}
