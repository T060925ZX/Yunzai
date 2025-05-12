import fs from "node:fs/promises"
import lodash from "lodash"
import moment from "moment"
import { segment } from "oicq"
import puppeteer from "puppeteer"

// 截图参数配置
const deviceScaleFactor = 1.2    // 设备缩放因子
const quality = 100    // 图片质量

// 主题模式配置 (day/night/auto)
const THEME_MODE = "auto" 

// 主题颜色定义
const THEMES = {
  day: {
    background: '#f5f7fa',
    containerBg: 'white',
    text: '#333',
    metaBg: '#fafafa',
    border: '#eee',
    header: '#1890ff',
    subheader: '#666',
    timestamp: '#666',
    info: '#1890ff',
    error: '#ff4d4f',
    warn: '#faad14',
    debug: '#666',
    jsonKey: '#92278f',
    jsonString: '#3ab54a',
    jsonNumber: '#25aae2',
    jsonBrace: '#333',
    jsonNull: '#666',
    bracketContent: '#1890ff'
  },
  night: {
    background: '#1a1a1a',
    containerBg: '#2d2d2d',
    text: '#e0e0e0',
    metaBg: '#252525',
    border: '#3d3d3d',
    header: '#58a6ff',
    subheader: '#aaa',
    timestamp: '#aaa',
    info: '#58a6ff',
    error: '#ff6b6b',
    warn: '#ffcc5c',
    debug: '#999',
    jsonKey: '#c678dd',
    jsonString: '#98c379',
    jsonNumber: '#61afef',
    jsonBrace: '#e0e0e0',
    jsonNull: '#aaa',
    bracketContent: '#58a6ff'
  }
}

export class sendLog extends plugin {
    constructor() {
        super({
            name: "发送日志",
            dsc: "发送最近100条运行日志",
            event: "message",
            priority: -Infinity,
            rule: [
                {
                    reg: "^#(运行|错误|系统)*日志[0-9]*(.*)",
                    fnc: "sendLog",
                    permission: "master"
                },
                {
                    reg: "^#定海神针$",
                    fnc: "sendLog",
                    permission: "master"
                }
            ]
        })

        this.lineNum = 100     // 默认显示行数
        this.maxNum = 1000     // 最大显示行数
        this.logFile = `logs/command.${moment().format("YYYY-MM-DD")}.log`  // 运行日志文件
        this.errFile = "logs/error.log"      // 错误日志文件
        this.browser = null    // Puppeteer浏览器实例
    }

    async sendLog() {
        // 处理 #定海神针 命令
        if (this.e.msg === "#定海神针") {
            this.lineNum = 100
            this.keyWord = ""
            this.e.msg = "#运行日志100"
        }

        // 提取行数参数
        let lineNum = this.e.msg.match(/\d+/g)
        if (lineNum) {
            this.lineNum = lineNum[0]
        } else {
            this.keyWord = this.e.msg.replace(/#|运行|错误|系统|日志|\d/g, "")
        }

        // 确定日志文件和类型
        let logFile = this.logFile
        let type = "运行"
        if (this.e.msg.includes("错误")) {
            logFile = this.errFile
            type = "错误"
        } else if (this.e.msg.includes("系统")) {
            logFile = this.logFile
            type = "系统"
        }

        if (this.keyWord) type = this.keyWord

        // 获取日志条目
        const logEntries = await this.getLogEntries(logFile)

        if (lodash.isEmpty(logEntries)) {
            return this.reply(`暂无相关日志：${type}`)
        }

        // 生成日志图片
        const imageBuffer = await this.renderLogsAsImage(logEntries, type)
        
        if (imageBuffer) {
            return this.reply(segment.image(imageBuffer))
        } else {
            return this.reply(await Bot.makeForwardArray([`最近${logEntries.length}条${type}日志`, logEntries.join("\n\n")]))
        }
    }

    async getLogEntries(logFile) {
        let logContent = await fs.readFile(logFile, "utf8").catch(() => "")
        const lines = logContent.split("\n")
        const entries = []
        let currentEntry = []

        // 解析日志条目（每个条目以时间戳开头）
        for (const line of lines) {
            if (line.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/)) {
                if (currentEntry.length > 0) {
                    entries.push(currentEntry.join("\n"))
                    currentEntry = []
                }
            }
            if (line.trim()) {
                currentEntry.push(line)
            }
        }

        // 添加最后一个条目
        if (currentEntry.length > 0) {
            entries.push(currentEntry.join("\n"))
        }

        // 关键词过滤
        if (this.keyWord) {
            return entries.filter(entry => entry.includes(this.keyWord)).slice(0, this.maxNum)
        }

        // 系统日志保持正序（旧的在前面），其他日志倒序（新的在前面）
        let shunxu;
        if (this.e.msg.includes("系统")) {
            shunxu = "正序"
            return entries.slice(-this.lineNum)
        } else {
            shunxu = "倒序"
            return entries.slice(-this.lineNum).reverse()
        }
    }

    async initBrowser() {
        if (this.browser) return this.browser
        
        try {
            this.browser = await puppeteer.launch({
                headless: "new",
                args: [
                    "--disable-gpu",
                    "--disable-setuid-sandbox",
                    "--no-sandbox",
                    "--no-zygote"
                ]
            })
            return this.browser
        } catch (err) {
            logger.error("Failed to launch puppeteer:", err)
            return null
        }
    }

    async renderLogsAsImage(logEntries, title) {
        const browser = await this.initBrowser()
        if (!browser) return null

        try {
            const page = await browser.newPage()
            
            // 确定当前主题
            let currentTheme
            let themeName
            
            if (THEME_MODE === "auto") {
                // 自动模式：根据北京时间6:00-18:00为日间
                const now = moment().utcOffset(8)
                const hour = now.hour()
                currentTheme = (hour >= 6 && hour < 18) ? THEMES.day : THEMES.night
                themeName = currentTheme === THEMES.day ? "日间模式" : "夜间模式"
            } else {
                // 手动指定模式
                currentTheme = THEMES[THEME_MODE] || THEMES.day
                themeName = THEME_MODE === "day" ? "日间模式" : "夜间模式"
            }

            // 生成日志HTML
            const logHtml = logEntries.map(entry => {
                // 提取时间戳和日志级别
                const timestampMatch = entry.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]/)
                const timestamp = timestampMatch ? timestampMatch[1] : ""
                
                const levelMatch = entry.match(/\[(\w+)\]/)
                let level = levelMatch ? levelMatch[1] : "INFO"
                let levelColor = currentTheme.info // 默认使用info颜色
                
                if (level === "ERRO") {
                    level = "ERROR"
                    levelColor = currentTheme.error
                } else if (level === "WARN") {
                    levelColor = currentTheme.warn
                } else if (level === "DEBUG") {
                    levelColor = currentTheme.debug
                }
                
                // 清理日志内容
                let content = entry
                  .replace(/\x1b\[[0-9;]*m/g, "") // 移除ANSI颜色代码
                  .replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/, "") // 移除时间戳
                  .replace(/\[(\w+)\]/, "") // 移除日志级别
                  .trim()

                // 过滤IP和端口
                content = content.replace(/(?:http[s]?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '[不许偷看噢~]')
                content = content.replace(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?/g, '[不许偷看噢~]')

                // 格式化JSON内容和[]内容
                content = content
                  .replace(/{/g, `<span class="json-brace">{</span>`)
                  .replace(/}/g, `<span class="json-brace">}</span>`)
                  .replace(/\[([^\]]+)\]/g, `<span class="bracket-content">[$1]</span>`)
                  .replace(/"([^"]+)":/g, `<span class="json-key">"$1"</span>:`)
                  .replace(/: ("[^"]+")/g, `: <span class="json-string">$1</span>`)
                  .replace(/: (\d+)/g, `: <span class="json-number">$1</span>`)
                  .replace(/: (undefined|null)/g, `: <span class="json-null">$1</span>`)
                  .replace(/(\s{4,})/g, `<span class="json-indent">$1</span>`)
                
                return `
                  <div class="log-entry">
                    <div class="log-meta">
                      <div class="log-level" style="background-color: ${levelColor}">${level}</div>
                      <div class="log-timestamp">${timestamp}</div>
                    </div>
                    <div class="log-content">
                      <pre>${content}</pre>
                    </div>
                  </div>
                `
            }).join("")

            const now = moment().utcOffset(8).format("YYYY-MM-DD HH:mm:ss")

            await page.setContent(`
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="UTF-8">
                <style>
                  * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                  }
                  body {
                    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
                    background-color: ${currentTheme.background};
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    padding: 15px;
                  }
                  .log-wrapper {
                    width: 100%;
                    max-width: 900px;
                    padding: 15px;
                  }
                  .log-container {
                    background-color: ${currentTheme.containerBg};
                    border-radius: 16px;
                    padding: 25px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
                    width: 100%;
                  }
                  .log-header {
                    color: ${currentTheme.header};
                    font-size: 24px;
                    font-weight: bold;
                    margin-bottom: 15px;
                    padding-bottom: 15px;
                    border-bottom: 2px solid ${currentTheme.header}20;
                    text-align: center;
                  }
                  .log-subheader {
                    color: ${currentTheme.subheader};
                    font-size: 14px;
                    text-align: center;
                    margin-bottom: 20px;
                  }
                  .log-entry {
                    display: flex;
                    margin: 12px 0;
                    background: ${currentTheme.containerBg};
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
                    border-left: 4px solid ${currentTheme.border};
                    transition: all 0.2s ease;
                  }
                  .log-entry:hover {
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
                    transform: translateY(-1px);
                  }
                  .log-meta {
                    min-width: 150px;
                    padding: 12px;
                    display: flex;
                    flex-direction: row;
                    align-items: center;
                    background-color: ${currentTheme.metaBg};
                    border-right: 1px solid ${currentTheme.border};
                    gap: 8px;
                  }
                  .log-timestamp {
                    color: ${currentTheme.timestamp};
                    font-size: 11px;
                    font-family: 'Consolas', monospace;
                  }
                  .log-level {
                    min-width: 60px;
                    padding: 4px 8px;
                    color: white;
                    font-weight: 600;
                    font-size: 12px;
                    text-align: center;
                    border-radius: 4px;
                    font-family: 'Consolas', monospace;
                    text-shadow: 0 1px 1px rgba(0,0,0,0.1);
                  }
                  .log-content {
                    flex: 1;
                    padding: 12px 15px;
                    color: ${currentTheme.text};
                    font-size: 13px;
                    line-height: 1.5;
                    overflow-x: auto;
                  }
                  .log-content pre {
                    margin: 0;
                    white-space: pre-wrap;
                    font-family: 'Consolas', 'Monaco', monospace;
                  }
                  .json-key {
                    color: ${currentTheme.jsonKey};
                  }
                  .json-string {
                    color: ${currentTheme.jsonString};
                  }
                  .json-number {
                    color: ${currentTheme.jsonNumber};
                  }
                  .json-brace, .json-bracket {
                    color: ${currentTheme.jsonBrace};
                    font-weight: bold;
                  }
                  .json-null {
                    color: ${currentTheme.jsonNull};
                  }
                  .json-indent {
                    display: inline-block;
                  }
                  .bracket-content {
                    color: ${currentTheme.bracketContent};
                    font-weight: bold;
                  }
                </style>
              </head>
              <body>
                <div class="log-wrapper">
                  <div class="log-container">
                    <div class="log-header">日志查看器 ☉ 最近${logEntries.length}条</div>
                    <div class="log-subheader">${title}日志 · ${now} · ${themeName}</div>
                    <div class="log-list">${logHtml}</div>
                    <div class="log-subheader">Created by Jiaozi ☉ deviceScaleFactor: ${deviceScaleFactor} quality: ${quality}</div>
                  </div>
                </div>
              </body>
              </html>
            `)

            await page.evaluateHandle('document.fonts.ready')

            // 设置视口大小
            await page.setViewport({
                width: 930, // 900 + 15px padding * 2
                height: 1080,
                deviceScaleFactor: deviceScaleFactor
            })

            // 获取容器元素
            const container = await page.$('.log-container')
            const boundingBox = await container.boundingBox()

            // 计算截图区域（包括15px留白）
            const clipArea = {
                x: Math.max(0, boundingBox.x - 15),
                y: Math.max(0, boundingBox.y - 15),
                width: boundingBox.width + 30,
                height: boundingBox.height + 30
            }

            // 截图整个容器（自动滚动）
            const imageBuffer = await page.screenshot({
                type: 'jpeg',
                quality: quality,
                clip: clipArea,
                captureBeyondViewport: true
            })

            await page.close()
            return imageBuffer

        } catch (err) {
            logger.error("Failed to render logs as image:", err)
            return null
        }
    }

    async destroy() {
        if (this.browser) {
            await this.browser.close().catch(err => logger.error(err))
            this.browser = null
        }
    }
}