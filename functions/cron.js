export async function scheduled(event, env, ctx) {
  const pending = await env.DB.prepare(
    "SELECT * FROM operations WHERE auto_check = 1 AND visa_status = 'قيد الفحص التلقائي'"
  ).all();

  for (const op of pending.results) {
    try {
      const sessionRes = await fetch('https://visa.mofa.gov.sa/VisaStatus/Search', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const html = await sessionRes.text();
      const cookies = sessionRes.headers.get('set-cookie') || '';
      const m = html.match(/src="(\/Captcha\/[^"]+)"/);
      if (!m) continue;

      const captchaUrl = `https://visa.mofa.gov.sa${m[1]}`;
      const imgRes = await fetch(captchaUrl, { headers: { Cookie: cookies } });
      const buf = await imgRes.arrayBuffer();

      let bin='';
      const b=new Uint8Array(buf);
      for(let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]);
      const base64 = btoa(bin);

      const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Return captcha text only" }, { inline_data: { mime_type: "image/jpeg", data: base64 } }] }]
        })
      });
      const gData = await gemRes.json();
      const captcha = gData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      const searchBody = new URLSearchParams({ PassportNumber: op.passportNumber, Captcha: captcha });
      const sRes = await fetch('https://visa.mofa.gov.sa/VisaStatus/Search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
        body: searchBody
      });
      const resultHtml = await sRes.text();

      if (resultHtml.includes('تم اصدار') || resultHtml.includes('Issued') || resultHtml.includes('تم إصدار')) {
        const pdfM = resultHtml.match(/href="([^"]*\.pdf[^"]*)"/i);
        if (pdfM) {
          const pdfUrl = pdfM[1].startsWith('http')? pdfM[1] : `https://visa.mofa.gov.sa${pdfM[1]}`;
          const pdfRes = await fetch(pdfUrl, { headers: { Cookie: cookies } });
          const pdfBuf = await pdfRes.arrayBuffer();

          const form = new FormData();
          form.append('file', new Blob([pdfBuf], {type: 'application/pdf'}), `${op.extractedName}-${op.passportNumber}.pdf`);
          form.append('type', 'application/pdf');
          form.append('messaging_product', 'whatsapp');

          const up = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/media`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.WHATSAPP_TOKEN}` },
            body: form
          });
          const { id } = await up.json();

          await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: op.customerPhone,
              type: 'document',
              document: {
                id,
                filename: `${op.extractedName}-${op.passportNumber}.pdf`,
                caption: `✅ تأشيرتك جاهزة\nالاسم: ${op.extractedName}\nرقم الجواز: ${op.passportNumber}`
              }
            })
          });
          await env.DB.prepare("UPDATE operations SET visa_status='تم الإرسال', auto_check=0 WHERE id=?").bind(op.id).run();
        }
      }
      await new Promise(r => setTimeout(r, 8000));
    } catch(e) {
      console.log(e.message);
    }
  }
                                                                                     }
