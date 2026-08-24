// MOFA visa-search nationality dropdown: code -> Arabic label, scraped from
// https://visa.mofa.gov.sa/visaservices/searchvisa (#NationalityId <select>).
// Used to resolve whatever nationality text our Gemini extraction produced
// (Arabic country name, English name, or ISO-3166 alpha-3 code) into the
// exact <option value="..."> MOFA expects.
const { MOFA_NATIONALITIES } = require('./mofa_nationalities_data')

// Common aliases: alternate Arabic spellings / English names / ISO codes ->
// MOFA code. Covers the nationalities most likely to submit Umrah visas
// through this platform. Extend as needed when unmatched cases show up in
// logs (see resolveNationality's fallback logging).
const ALIASES = {
  // Yemen
  'yemen': 'YEM', 'اليمن': 'YEM', 'يمني': 'YEM', 'يمنية': 'YEM', 'yem': 'YEM',
  // Egypt
  'egypt': 'EGY', 'مصر': 'EGY', 'مصري': 'EGY', 'مصرية': 'EGY', 'egy': 'EGY',
  // Sudan
  'sudan': 'SDN', 'السودان': 'SDN', 'سوداني': 'SDN', 'سودانية': 'SDN', 'sdn': 'SDN',
  // Syria
  'syria': 'SYR', 'سوريا': 'SYR', 'سوري': 'SYR', 'سورية': 'SYR', 'syr': 'SYR',
  // Jordan
  'jordan': 'JOR', 'الاردن': 'JOR', 'الأردن': 'JOR', 'اردني': 'JOR', 'أردني': 'JOR', 'jor': 'JOR',
  // Palestine
  'palestine': 'PSE', 'فلسطين': 'PSE', 'فلسطيني': 'PSE', 'فلسطينية': 'PSE', 'pse': 'PSE',
  // Lebanon
  'lebanon': 'LBN', 'لبنان': 'LBN', 'لبناني': 'LBN', 'لبنانية': 'LBN', 'lbn': 'LBN',
  // Iraq
  'iraq': 'IRQ', 'العراق': 'IRQ', 'عراقي': 'IRQ', 'عراقية': 'IRQ', 'irq': 'IRQ',
  // Morocco
  'morocco': 'MAR', 'المغرب': 'MAR', 'مغربي': 'MAR', 'مغربية': 'MAR', 'mar': 'MAR',
  // Algeria
  'algeria': 'DZA', 'الجزائر': 'DZA', 'جزائري': 'DZA', 'جزائرية': 'DZA', 'dza': 'DZA',
  // Tunisia
  'tunisia': 'TUN', 'تونس': 'TUN', 'تونسي': 'TUN', 'تونسية': 'TUN', 'tun': 'TUN',
  // Libya
  'libya': 'LBY', 'ليبيا': 'LBY', 'ليبي': 'LBY', 'ليبية': 'LBY', 'lby': 'LBY',
  // Somalia
  'somalia': 'SOM', 'الصومال': 'SOM', 'صومالي': 'SOM', 'صومالية': 'SOM', 'som': 'SOM',
  // Pakistan
  'pakistan': 'PAK', 'باكستان': 'PAK', 'باكستاني': 'PAK', 'باكستانية': 'PAK', 'pak': 'PAK',
  // India
  'india': 'IND', 'الهند': 'IND', 'هندي': 'IND', 'هندية': 'IND', 'ind': 'IND',
  // Bangladesh
  'bangladesh': 'BGD', 'بنغلاديش': 'BGD', 'بنجلاديش': 'BGD', 'bgd': 'BGD',
  // Indonesia
  'indonesia': 'IDN', 'اندونيسيا': 'IDN', 'إندونسيا': 'IDN', 'اندونيسي': 'IDN', 'idn': 'IDN',
  // Philippines
  'philippines': 'PHL', 'الفلبين': 'PHL', 'فلبيني': 'PHL', 'فلبينية': 'PHL', 'phl': 'PHL',
  // Turkey
  'turkey': 'TUR', 'تركيا': 'TUR', 'تركي': 'TUR', 'تركية': 'TUR', 'tur': 'TUR',
  // Comoros
  'comoros': 'COM', 'جزر القمر': 'COM', 'قمري': 'COM', 'com': 'COM',
  // Djibouti
  'djibouti': 'DJI', 'جيبوتي': 'DJI', 'dji': 'DJI',
  // Mauritania
  'mauritania': 'MRT', 'موريتانيا': 'MRT', 'موريتاني': 'MRT', 'mrt': 'MRT',
  // Eritrea
  'eritrea': 'ERI', 'اريتريا': 'ERI', 'إريتيريا': 'ERI', 'أريتيريا': 'ERI', 'eri': 'ERI',
  // Ethiopia
  'ethiopia': 'ETH', 'اثيوبيا': 'ETH', 'إثيوبيا': 'ETH', 'eth': 'ETH',
  // Chad
  'chad': 'TCD', 'تشاد': 'TCD', 'tcd': 'TCD',
  // Niger
  'niger': 'NER', 'النيجر': 'NER', 'ner': 'NER',
  // Senegal
  'senegal': 'SEN', 'السنغال': 'SEN', 'sen': 'SEN',
  // Nigeria
  'nigeria': 'NGA', 'نيجيريا': 'NGA', 'nga': 'NGA',
  // Kenya
  'kenya': 'KEN', 'كينيا': 'KEN', 'ken': 'KEN',
  // Afghanistan
  'afghanistan': 'AFG', 'افغانستان': 'AFG', 'أفغانستان': 'AFG', 'afg': 'AFG',
  // United States / UK etc (less common but possible)
  'usa': 'USA', 'united states': 'USA', 'الولايات المتحدة': 'USA', 'امريكا': 'USA', 'أمريكا': 'USA',
  'uk': 'GBR', 'united kingdom': 'GBR', 'بريطانيا': 'GBR', 'المملكة المتحدة': 'GBR'
}

function normalize(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, '') // strip Arabic diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
}

// Build a normalized reverse lookup from the scraped MOFA option labels too,
// so exact/near matches against MOFA's own wording work without needing an
// alias entry.
const NORMALIZED_LABELS = {}
for (const [code, label] of Object.entries(MOFA_NATIONALITIES)) {
  NORMALIZED_LABELS[normalize(label)] = code
}
const NORMALIZED_ALIASES = {}
for (const [key, code] of Object.entries(ALIASES)) {
  NORMALIZED_ALIASES[normalize(key)] = code
}

/**
 * Resolve a free-text nationality (Arabic country name, English name, or
 * ISO-3166 alpha-3 code) extracted by Gemini into the MOFA dropdown's
 * <option value>. Returns null if no confident match is found (caller
 * should log this so the alias table can be extended).
 */
function resolveNationality(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()

  // Already a valid MOFA code (case-insensitive)?
  const upper = trimmed.toUpperCase()
  if (MOFA_NATIONALITIES[upper]) return upper

  const norm = normalize(trimmed)
  if (NORMALIZED_ALIASES[norm]) return NORMALIZED_ALIASES[norm]
  if (NORMALIZED_LABELS[norm]) return NORMALIZED_LABELS[norm]

  // Loose substring match against MOFA labels as a last resort (handles
  // minor extraction variance like extra spaces/diacritics we didn't
  // anticipate).
  for (const [label, code] of Object.entries(NORMALIZED_LABELS)) {
    if (label.length >= 3 && (label.includes(norm) || norm.includes(label))) {
      return code
    }
  }

  return null
}

module.exports = { resolveNationality, MOFA_NATIONALITIES }
