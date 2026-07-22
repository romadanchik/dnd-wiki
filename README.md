# База кампании D&D — сайт

Статический сайт для D&D-вики, собранный из Obsidian-vault движком
[Quartz v5](https://quartz.jzhao.xyz/) и публикуемый на GitHub Pages.

**Адрес сайта:** https://dnd.danishe.sbs/

## Как это устроено

- **Источник заметок** — Obsidian-vault в `D:\Agent\DnD-Vault` (его правишь в Obsidian).
- **Этот репозиторий** — движок Quartz + копия заметок в папке `content/`.
- При каждом `push` в ветку `main` GitHub Action собирает сайт и публикует его.

Vault и сайт — два отдельных репозитория. Заметки переносятся в `content/`
скриптом синхронизации; вручную в `content/` ничего менять не нужно.

## Обновление сайта после правок в Obsidian

```powershell
# 1. Перенести свежие заметки из vault в content/
.\sync-content.ps1

# 2. Закоммитить и запушить — деплой запустится сам
git add -A
git commit -m "Обновление заметок"
git push
```

Скрипт `sync-content.ps1` зеркалит `DnD-Vault` → `content/` (исключая `.git`
и `.obsidian`) и делает дашборд `00 Старт.md` главной страницей (`index.md`).

## Локальный предпросмотр

```powershell
npm ci                                            # один раз — зависимости
node ./quartz/bootstrap-cli.mjs plugin install    # один раз — плагины Quartz
node ./quartz/bootstrap-cli.mjs build --serve     # http://localhost:8080
```

> На Windows вызывай CLI через `node ./quartz/bootstrap-cli.mjs ...`
> (`npx quartz ...` иногда сбоит с кэшем npx).

## Настройка

- `quartz.config.yaml` — заголовок, `baseUrl`, локаль (`ru-RU`), тема, плагины.
- `.github/workflows/deploy.yml` — сборка и деплой на GitHub Pages.

## Форк плагина графа (`plugins/graph`)

Граф — **локальная копия** `quartz-community/graph` с двумя добавленными опциями:

- **`hideTags: [...]`** — заметки с указанными тегами не попадают в граф, но
  остаются в поиске, RSS и sitemap (в upstream можно скрыть только узлы-теги,
  а не сами заметки).
- **`hideFolderPages: true`** — убирает сгенерированные страницы-индексы папок
  (`npc/index`, `боги/index`, …). Главная (`index`) не затрагивается.

Плюс исправлено поведение upstream: при `showTags: false` теперь убираются и
**страницы тегов** (`tags/*`). Раньше они оставались в графе одинокими узлами,
потому что живут в `contentIndex` как обычные страницы, и на них никто не
ссылается.

Настраивается в `quartz.config.yaml`:

```yaml
- source: ./plugins/graph          # локальный форк, не github:
  options:
    globalGraph:
      hideTags: [changelog, дашборд, служебное, сессия]
```

**Если правишь `plugins/graph/src/`** — пересобери `dist` и закоммить его:

```powershell
cd plugins/graph
npm install       # один раз
npm run build     # tsup -> dist/
```

`dist/` намеренно лежит в git (так же поставляются все upstream-плагины Quartz) —
тогда CI берёт готовую сборку и не ставит зависимости плагина.

> ⚠️ Тонкости, на которые легко напороться:
> - `npx quartz plugin install` (режим lockfile) **молча пропускает** локальные
>   плагины — поэтому в workflow есть отдельный шаг с `--from-config`.
> - Он же сначала делает `rm -rf .quartz/plugins/graph`: восстановленный из кэша
>   старый upstream-граф заставил бы `--from-config` решить, что плагин уже стоит.
> - Записи `graph` в `quartz.lock.json` быть не должно. `--from-config` дописывает
>   её с абсолютным путём этой машины; в CI такой путь не существует и install
>   ругается «1 failed» (не фатально, но лучше запись удалить перед коммитом).

## Первичная настройка GitHub Pages

1. Создать на GitHub репозиторий `dnd-wiki` (пустой, без README).
2. `git remote add origin https://github.com/DanilShekarev/dnd-wiki.git`
3. `git push -u origin main`
4. На GitHub: **Settings → Pages → Source → GitHub Actions**.
