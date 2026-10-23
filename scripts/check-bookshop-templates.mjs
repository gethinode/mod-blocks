// Runs every component template through Bookshop's own template translator, the
// step the CloudCannon Visual Editor performs before live rendering. A template the
// translator rejects breaks live editing for the whole page, while the regular Hugo
// build still passes. One known trigger is an unbalanced quote inside a {{/* */}}
// comment, such as the apostrophe in "site's".
import fs from 'node:fs'
import path from 'node:path'
// The package exports map hides lib/, so load the translator next to the main entry.
const engine = new URL('.', import.meta.resolve('@bookshop/hugo-engine'))
const { default: translateTextTemplate } = await import(new URL('lib/translateTextTemplate.js', engine))

const root = 'component-library'
const templates = fs.readdirSync(root, { recursive: true })
  .filter(file => file.endsWith('.hugo.html'))
  .map(file => path.join(root, file))

let failures = 0
for (const file of templates) {
  try {
    translateTextTemplate(fs.readFileSync(file, 'utf8'), {})
  } catch (error) {
    failures++
    console.error(`${file}: ${error.message.split('\n')[0]}`)
  }
}

if (failures > 0) {
  console.error(`${failures} of ${templates.length} Bookshop templates cannot be translated for live editing`)
  process.exit(1)
}
console.log(`All ${templates.length} Bookshop templates translate for live editing`)
