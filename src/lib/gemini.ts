
import { GoogleGenerativeAI } from '@google/generative-ai'

const PASSPORT_PROMPT = `
أنت خبير في قراءة جوازات السفر اليمنية والسعودية والمصرية وكل الجوازات العربية.
مهمتك استخراج البيانات بدقة عالية جدا من صورة جواز السفر.

قواعد مهمة جدا:
1. إذا الصورة ليست جواز سفر، أرجع is_passport = false
2. إذا الصورة غير واضحة أو مقصوصة أو فيها انعكاس ضوء يمنع القراءة، أرجع is_clear = false مع سبب واضح
3. لا تخمن أبدا - إذا الرقم غير واضح قل غير واضح
4. انتبه للاسم العربي - اكتبه كامل كما في الجواز بالضبط
5. رقم الجواز هو 8 أرقام عادة

أرجع JSON فقط بهذا الشكل:
{
  "is_passport": true/false,
  "is_clear": true/false,
  "clarity_reason": "سبب عدم الوضوح إن وجد",
  "full_name_ar": "الاسم الكامل بالعربي",
  "full_name_en": "الاسم بالانجليزي",
  "passport_number": "رقم الجواز",
  "nationality": "الجنسية",
  "date_of_birth": "YYYY-MM-DD",
  "date_of_expiry": "YYYY-MM-DD",
  "gender": "M/F"
}

مهم: أرجع JSON فقط، بدون أي نص إضافي.
`

export async function extractPassportData(apiKey: string, base64: string, mimeType: string, retries = 2): Promise<any> {
  let lastError: any = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey)
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1000,
        }
      })

      const result = await model.generateContent([
        { text: PASSPORT_PROMPT },
        {
          inlineData: {
            data: base64,
            mimeType: mimeType
          }
        }
      ])

      const text = result.response.text()
      
      // تنظيف النص من علامات markdown
      let cleanText = text.trim()
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim()
      }

      const parsed = JSON.parse(cleanText)
      
      // تحقق أساسي
      if (typeof parsed.is_passport !== 'boolean') parsed.is_passport = true
      if (typeof parsed.is_clear !== 'boolean') parsed.is_clear = true

      return parsed

    } catch (err: any) {
      lastError = err
      console.error(`Gemini attempt ${attempt + 1} failed:`, err?.message || err)
      
      // إذا كان خطأ Rate limit أو شبكة، انتظر ثم أعد المحاولة
      if (err?.message?.includes('429') || err?.message?.includes('quota') || err?.message?.includes('fetch')) {
        if (attempt < retries) {
          const waitMs = (attempt + 1) * 2000 // 2s, 4s
          console.log(`Waiting ${waitMs}ms before retry...`)
          await new Promise(r => setTimeout(r, waitMs))
          continue
        }
      }
      
      // إذا كان خطأ JSON parsing، حاول مرة أخرى مرة واحدة فقط
      if (err instanceof SyntaxError && attempt < 1) {
        await new Promise(r => setTimeout(r, 1000))
        continue
      }

      // أخطاء أخرى لا تستحق إعادة المحاولة
      if (attempt === retries) break
    }
  }

  // بعد كل المحاولات فشل
  throw new Error(`فشل استخراج بيانات الجواز بعد ${retries + 1} محاولات: ${lastError?.message || lastError}`)
}
