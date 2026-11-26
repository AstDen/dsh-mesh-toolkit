/**
 * mesh-stl/lib/skill.js — bundled skill text (registered via ctx.skills.register).
 * @module mesh-stl/lib/skill
 */
export const SKILL = {
  name: 'mesh-stl',
  description: 'STL geometry generation and QA for the Mesh_3D_pore_scale project: generator families '
    + '(FCC cell, channel with sphere packing, double-layer burner, packings, CadQuery CAD), STL contract '
    + 'checks (watertight, winding, units mm), cleanup, passport registration. Use before meshing or when '
    + 'an STL fails QA.',
  whenToUse: 'When you need to create or verify a pore-scale STL, register a geometry passport, or decide '
    + 'which generator/preset to use. Pair with the mesh-build plugin for meshing.',
  content: `# mesh-stl — генерация и проверка STL

## Инструменты (3)
- **stl_hints** — карточки знаний проекта (проверенные правила + доказательства + рецепты).
  Без аргументов — каталог; \`query\` — поиск; \`id\` — одна карточка.
- **stl_generate** — запускает реальный генератор из реестра \`data/generators.json\`.
  Без \`family\` — список семей и пресетов. Пишет params/logs/STL и сам проверяет каждый выход встроенным QA (JS, без python).
- **stl_check** — проверка STL: watertight, winding, число тел, объём/площадь/bbox, чистка
  (\`cleanup:true\`) и паспорт в \`stl/registry.csv\` (\`register:true\`).

## Порядок работы
1. \`stl_hints({ query: "<задача>" })\` — прочитать применимые правила, не изобретать числа.
2. \`stl_generate({ family, preset, name, params? })\` — сгенерировать (dryRun:true сначала, если дорого).
3. \`stl_check({ stl, cleanup:true, register:true, expectVolume })\` — вердикт PASS обязателен.
4. Передать чистый STL в mesh-build: \`mesh_build({ route:"snappy", scaffold:true, caseDir, stl:["<name>.clean.stl"], scaffoldOptions:{ domainMin, domainMax, cellSize, locationInMesh } })\`; для уже готового кейса — \`scaffold:false\` + \`caseDir\`.

## Жёсткие правила
- STL только в **мм**; watertight + согласованные нормали — контракт (R9).
- Сырой CAD/CSG STL не мешить: сначала \`cleanup\`, для мешера брать \`*.clean.stl\`.
- Минимальный зазор ≥ 2·MeshSizeMin; контакты «нулевого зазора» запрещены (D-007/D-008).
- Параметры генерации фиксируются в \`<name>.params.json\` рядом с STL — reproducibility (R4).
- Если \`stl_check\` вернул FAIL — сначала карточка \`stl-cleanup\`, потом повторная проверка; не мешить битый STL.

## Как расширять (без правки кода)
- Новый генератор: добавить объект в \`data/generators.json\` (id, script, steps, outputs, preset).
  Плейсхолдеры: \`{paramsFile} {outDir} {name} {json} {rawOut} {cleanOut} {solidOut} {fluidOut}\`
  \`{fluidPatchesOut} {ballsCsv} {contactsCsv} {packingJson}\`.
- Новое правило/ловушка: добавить JSON-карточку в \`data/hints/*.json\` (поля id, title, topics,
  status verified/derived/unverified, when, statement, recipe[], evidence[], improves[], appliesTo[]).
- Убрать инструмент или семейство: удалить запись из данных; список генераторов виден в stl_generate.
- После правки данных: \`plugin_manager action:"list_plugins"\` → переустановить/перезапустить при необходимости.
`,
}
