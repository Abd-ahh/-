export function baseHead(title: string): string {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
    <link href="/static/style.css" rel="stylesheet">
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: { sans: ['Tajawal', 'sans-serif'] },
            colors: {
              brand: {
                50: '#eefdf6', 100: '#d5f9e8', 200: '#aef1d3', 300: '#75e3b6',
                400: '#3ccd94', 500: '#17b37a', 600: '#0c9163', 700: '#0b7451',
                800: '#0d5c43', 900: '#0c4b38'
              }
            }
          }
        }
      }
    </script>
    <style>
      body { font-family: 'Tajawal', sans-serif; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: #17b37a55; border-radius: 4px; }
    </style>
  `
}
