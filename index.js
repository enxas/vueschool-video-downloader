import puppeteer from "puppeteer"
import axios from "axios"
import fs from "fs"
import path from "path"
import ffmpeg from "fluent-ffmpeg"
import ffmpegPath from "ffmpeg-static"
import { unlink, readFile, mkdir } from "fs/promises"

const __dirname = path.resolve()
const settings = await loadSettings("settings.json")

let currentCourseName = ""

await start()

async function start() {
	const browser = await puppeteer.launch({ headless: true })
	const page = await browser.newPage()
	await page.setViewport({ width: 800, height: 600 })

	await login(page)

	await downloadCourses(page, settings.downloadCourses)

	await browser.close()

	console.log("Finished downloading.")
}

async function downloadCourses(page, courses) {
	for (const course of courses) {
		const chapters = await getChapters(page, course)

		for (let i = 0; i < chapters.length; i++) {
			console.log(`Chapter: ${chapters[i].chapter}`)

			for (let j = 0; j < chapters[i].lessons.length; j++) {
				await downloadLesson(
					page,
					`${i + 1}. ${chapters[i].chapter}`,
					chapters[i].lessons[j],
					j + 1
				)
			}
		}
	}
}

async function loadSettings(settingsFile) {
	console.log("Loading settings file.")

	try {
		const data = await readFile(settingsFile, "utf8")

		return JSON.parse(data)
	} catch (err) {
		console.error("Error:", err)
	}
}

async function createDirectory(dir) {
	try {
		await mkdir(dir, { recursive: true })
	} catch (err) {
		console.error("Error creating directories:", err)
	}
}

async function login(page) {
	console.log(`Logging in as: ${settings.email}`)

	await page.goto("https://vueschool.io/login")

	await page.waitForSelector('input[tabindex="1"]')

	// type in email and password
	await page.type('input[tabindex="1"]', settings.email)
	await page.type('input[tabindex="2"]', settings.password)

	// click login button
	await page.click('button[tabindex="3"]')

	await page.waitForNavigation()
}

async function downloadLesson(page, chaptername, lesson, index) {
	await page.goto(lesson.url)
	await page.waitForSelector('iframe[src^="https://player.vimeo.com/video"]')

	const elementHandle = await page.$(
		'iframe[src^="https://player.vimeo.com/video"]'
	)
	// get the iframe's content frame
	const frame = await elementHandle.contentFrame()

	await frame.waitForSelector("#prefs-control-bar-button")
	await frame.click("#prefs-control-bar-button")

	await frame.evaluate(() => {
		const span = Array.from(document.querySelectorAll("span")).find((span) =>
			span.textContent.includes("Quality")
		)
		if (span) {
			span.click()
		} else {
			console.error("Span element not found")
		}
	})

	await frame.evaluate(() => {
		const span = Array.from(document.querySelectorAll("span")).find((span) =>
			span.textContent.includes("1080p")
		)
		if (span) {
			span.click()
		} else {
			console.error("Span element not found")
		}
	})

	await frame.evaluate(() => {
		const span = Array.from(document.querySelectorAll("span")).find((span) =>
			span.textContent.includes("1080p")
		)
		if (span) {
			span.click()
		} else {
			console.error("Span element not found")
		}
	})

	const vimeoUrls = []

	const requestHandler = (request) => {
		const url = request.url()
		if (
			url.startsWith("https://vod-adaptive-ak.vimeocdn.com") &&
			url.includes(".mp4") &&
			vimeoUrls.length !== 2
		) {
			let cleanUrl = new URL(url)
			cleanUrl.searchParams.delete("range")
			vimeoUrls.push(cleanUrl.toString())
		}
		request.continue()
	}

	// enable request interception
	await page.setRequestInterception(true)
	page.on("request", requestHandler)

	await frame.click('[data-play-button="true"]')
	await frame.waitForSelector('[aria-label="Progress Bar"]')
	const progressBar = await frame.$('[aria-label="Progress Bar"]')

	// wait until the aria-valuenow attribute is non-zero (video is playing)
	await waitForNonZeroValue(progressBar, "aria-valuenow")

	await frame.click('[data-play-button="true"]')

	page.off("request", requestHandler)
	await page.setRequestInterception(false)

	const savePath = path.join(
		settings.downloadPath,
		currentCourseName,
		chaptername
	)

	const filenames = []

	console.log(`Downloading lesson: ${lesson.name}`)

	for (const url of vimeoUrls) {
		filenames.push(await downloadFile(url, savePath))
	}

	await mergeFiles(filenames, savePath, `${index}. ${lesson.name}`)
}

async function waitForNonZeroValue(element, attribute, interval = 1000) {
	return new Promise((resolve) => {
		const checkValue = async () => {
			const value = await element.evaluate(
				(el, attr) => el.getAttribute(attr),
				attribute
			)
			if (parseInt(value, 10) > 0) {
				clearInterval(intervalId)
				resolve(value)
			}
		}
		const intervalId = setInterval(checkValue, interval)
	})
}

async function getChapters(page, course) {
	await page.goto(course)
	await page.waitForSelector("h1[title]")
	currentCourseName = await page.$eval("h1[title]", (el) => el.textContent)

	console.log(`Downloadng course: "${currentCourseName}"`)

	const chapterElements = await page.$$('[class="chapter"]')
	const chapters = []

	for (const chapter of chapterElements) {
		const currentchapter = {}

		const chapterTitle = await chapter.$("h2[title]")
		if (chapterTitle) {
			currentchapter.chapter = await chapterTitle.evaluate(
				(el) => el.textContent
			)
			currentchapter.lessons = []
		} else {
			console.log("No h2 with title attribute found in this chapter.")
		}

		currentchapter.lessons = await chapter.$$eval(
			'a[class="title"]',
			(anchors) => {
				return anchors.map((anchor) => ({
					url: anchor.href,
					name: anchor.textContent.replace(/[<>:"/\\|?*]+/g, " "), // replace illegal characters with space
				}))
			}
		)

		chapters.push(currentchapter)
	}

	return chapters
}

async function downloadFile(url, savePath) {
	await createDirectory(savePath)

	const urlObj = new URL(url)
	const pathname = urlObj.pathname
	const filename = path.basename(pathname.split("/v2/range/avf/")[1])
	const response = await axios({ url, method: "GET", responseType: "stream" })
	const filePath = path.resolve(savePath, `${filename}`)
	const writer = fs.createWriteStream(filePath)
	response.data.pipe(writer)

	return new Promise((resolve, reject) => {
		writer.on("finish", () => resolve(filename))
		writer.on("error", reject)
	})
}

function mergeFiles(fileNames, savePath, fileName) {
	const audioFile = path.join(savePath, fileNames[0])
	const videoFile = path.join(savePath, fileNames[1])

	ffmpeg.setFfmpegPath(ffmpegPath)

	return new Promise((resolve, reject) => {
		ffmpeg()
			.input(audioFile)
			.input(videoFile)
			.outputOptions("-c copy") // copy the streams without re-encoding
			.output(path.join(savePath, fileName + ".mp4"))
			.on("end", async () => {
				await unlink(audioFile)
				await unlink(videoFile)

				return resolve()
			})
			.on("error", (err) => {
				console.error("Error: ", err)
				return reject(err)
			})
			.run()
	})
}
