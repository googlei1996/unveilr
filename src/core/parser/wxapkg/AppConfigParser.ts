import { ParserError, BaseParser } from '../BaseParser'
import { WxapkgKeyFile } from '@/enum'
import { PathController, ProduciblePath } from '@core/controller/PathController'
import { Visitor } from '@babel/core'
import { AppConfigServiceSubject, S2Observable, TVSubject } from '@core/parser/wxapkg/types'
import { Saver } from '@utils/classes/Saver'
import { filter } from 'observable-fns'
import { md5 } from '@utils/crypto'
import { findBuffer } from '@core/controller/SaveController'
import { info } from '@utils/colors'

interface PageInfo {
  [key: string]: {
    window: { usingComponents: { [key: string]: unknown }; [key: string]: unknown }
  }
}
interface TabBarItem {
  iconPath?: string
  iconData?: string
  selectedIconPath?: string
  selectedIconData?: string
  pagePath?: string
}
export class AppConfigParser extends BaseParser {
  private serviceSource: string
  private sources: string
  isGame = false

  constructor(saver: Saver) {
    super(saver)
  }
  async parse(observable: S2Observable<TVSubject>): Promise<void> {
    try {
      if (this.isGame) return this.parseGame()
      const dirCtrl = this.saver.saveDirectory
      const config = {
        ...JSON.parse(this.sources),
        pop<T>(key, _default?: T): T {
          const result = config[key]
          delete config[key]
          return result || _default
        },
      }
      // 处理入口
      const entryPagePath = PathController.make(config.pop('entryPagePath'))
      const pages: string[] = config.pop('pages')
      const global = config.pop('global')
      const epp = entryPagePath.whitout().unixpath
      const seenPage = new Set()
      const save = (path: ProduciblePath, buffer: string | object) => {
        const filename = PathController.make(path).unixpath
        if (seenPage.has(filename)) return
        seenPage.add(filename)
        this.saver.add(path, buffer)
      }
      pages.splice(pages.indexOf(epp), 1)
      pages.unshift(epp)
      // 处理分包路径
      const subPackages: { [key: string]: unknown }[] = config.pop('subPackages')
      if (subPackages) {
        subPackages.forEach((subPack) => {
          const root = subPack.root as string
          const _subPages = (subPack.pages as string[]) || pages.filter((p) => p.startsWith(root))
          subPack.pages = _subPages.map((page) => {
            const _index = pages.indexOf(page)
            _index > 0 && pages.splice(_index, 1)
            return page.replace(root, '')
          })
        })
        this.logger.info(`AppConfigParser detected ${info(subPackages.length.toString())} subpackages`)
      }
      // 处理 ext.json
      const extAppid = config.pop('extAppid')
      const ext = config.pop('ext')
      if (extAppid && ext) {
        const logPath = dirCtrl.join('ext.json').writeJSONSync({ extEnable: true, extAppid, ext }).logpath
        this.logger.info(`Ext save to ${logPath}`)
      }
      // tabBar
      const tabBar = config.pop('tabBar')
      const ignoreSuffixes = 'wxml,wxs,wxss,html,json'
      if (tabBar && Array.isArray(tabBar.list)) {
        const hashMap: Record<string, string> = Object.create(null)
        findBuffer(dirCtrl).forEach(({ key, buffer }) => {
          const pCtrl = PathController.unix(key)
          if (ignoreSuffixes.includes(pCtrl.suffixWithout)) return
          if (!Buffer.isBuffer(buffer)) return
          hashMap[md5(buffer)] = pCtrl.crop(dirCtrl.absunixpath).unixpath
        })
        tabBar.list.forEach((item: TabBarItem) => {
          item.pagePath = PathController.make(item.pagePath).whitout().unixpath
          if (item.iconData) {
            const path = hashMap[md5(item.iconData, true)]
            if (path) {
              item.iconPath = PathController.make(path).unixpath
              delete item.iconData
            }
          }
          if (item.selectedIconData) {
            const path = hashMap[md5(item.selectedIconData, true)]
            if (path) {
              item.selectedIconPath = PathController.make(path).unixpath
              delete item.selectedIconData
            }
          }
        })
      }
      // usingComponents
      const page: PageInfo = config.pop('page')
      config.pop('renderer')
      Object.keys(page).forEach((key) => {
        const usingComponents = page[key].window.usingComponents
        if (!usingComponents || !Object.keys(usingComponents).length) return
        Object.keys(usingComponents).forEach((k) => {
          const p = (usingComponents[k] as string).replace('plugin://', '/__plugin__/')
          const file = p.startsWith('/') ? p.slice(1) : PathController.make(key).join('..', p).unixpath
          page[file] = page[file] || Object.create(null)
          page[file].window = page[file].window || Object.create(null)
          page[file].window.component = true
        })
      })
      const result = Object.assign(config, {
        tabBar,
        subPackages,
        ...global,
        pages,
      })
      save(WxapkgKeyFile.APP_JSON, result)
      // usingComponents -> json
      if (!this.serviceSource) ParserError.throw(`Service source not found!`)
      let resolve
      const promise = new Promise<void>((_resolve) => (resolve = _resolve))
      observable.pipe<S2Observable<AppConfigServiceSubject>>(filter((v) => v.AppConfigService)).subscribe({
        next: (value) => {
          Object.entries(value.AppConfigService).forEach((args) => save(...args))
        },
        complete() {
          Object.keys(page).forEach((key) => {
            let pCtrl = PathController.make(key)
            if (pCtrl.suffix !== '.json') pCtrl = pCtrl.whitout('.json')
            save(pCtrl, page[key]['window'])
          })
          resolve && resolve()
        },
      })
      return promise
    } catch (e) {
      ParserError.throw('Parse failed! ' + e.message)
    }
  }
  parseGame() {
    const config = JSON.parse(this.sources)
    const subPackages = config['subPackages']
    subPackages && this.logger.info(`AppConfigParser detected ${info(subPackages.length.toString())} subpackages`)
    this.saver.add(WxapkgKeyFile.GAME_JSON, this.sources)
  }

  setServiceSource(source: string) {
    this.serviceSource = source
  }
  setSources(sources: string) {
    this.sources = sources
  }
  setIsGame(isGame: boolean) {
    this.isGame = isGame
  }
  static visitor(subject: AppConfigServiceSubject): Visitor {
    return {
      AssignmentExpression(path) {
        const left = path.node.left
        if (
          left &&
          left.type === 'MemberExpression' &&
          left.object.type === 'Identifier' &&
          left.object.name === '__wxAppCode__' &&
          left.property.type === 'StringLiteral' &&
          left.property.value.endsWith('.json')
        ) {
          const key = left.property.value
          path.traverse({
            ObjectExpression(p) {
              if (p.parentKey === 'right') {
                subject.next({
                  AppConfigService: {
                    [key]: p.getSource(),
                  },
                })
              }
            },
          })
        }
      },
    }
  }
}
