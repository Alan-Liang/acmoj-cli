const { red, bold, yellow, green, blue, magenta } = require('colorette')
const Conf = require('conf')
const enquirer = require('enquirer')
const fetch = require('node-fetch')
const fs = require('fs')
const { spawnSync } = require('child_process')
const path = require('path')
const yargs = require('yargs/yargs')(process.argv.slice(2))
  .strict()
  .command('login', 'sign in to ACM Online Judge', yargs => {
    yargs.option('remember', {
      alias: 'r',
      describe: 'remembers password. NOTE: stores your password in plaintext on disk.',
    }).option('force', {
      alias: 'f',
      describe: 'force relogin even if already logged in.',
    })
  })
  .command('logout', 'sign out from ACM Online Judge')
  .command('submit [problemId] [sourceFile]', 'submit a problem', yargs => {
    yargs.positional('problemId', {
      describe: 'problem ID on online judge',
      type: 'number',
    }).positional('sourceFile', {
      describe: 'source file to submit, if omitted it tries to find in some common locations before giving up.',
      type: 'string',
    }).option('yes', {
      alias: 'y',
      describe: 'answer yes to all questions',
      type: 'boolean',
    }).example('$0 submit 1000 src/1000.cpp')
  })
  .command('git [problemId]', 'configure current git repo to be submitted', yargs => {
    yargs.positional('problemId', {
      describe: 'problem ID on online judge',
      type: 'number',
    }).option('yes', {
      alias: 'y',
      describe: 'answer yes to all questions',
      type: 'boolean',
    }).alias('f', 'yes').alias('force', 'yes').demandOption('problemId')
  })
  .alias('v', 'version')
  .alias('h', 'help')
  .help()

const args = yargs.argv
if (args._.length === 0) {
  yargs.showHelp()
  process.exit(1)
}

const config = new Conf({
  defaults: {
    baseUrl: 'https://acm.sjtu.edu.cn/OnlineJudge/',
  },
  configFileMode: 0o600,
})

const SUCCESS = bold(green('✔'))
const INFO = bold(blue('ℹ'))
const ERROR = bold(red('✖ error:'))
const WARN = bold(yellow('! warning:'))

let baseUrl
try {
  baseUrl = new URL(config.get('baseUrl'))
} catch (e) {
  console.log(`${ERROR} it seems you have a broken configuration file. try removing this file: ${config.path}`)
  process.exit(1)
}

const hasToken = () => config.has('loginId')
const getToken = () => config.get('loginId')
const getUsername = () => config.get('username')
const getPassword = () => Buffer.from(config.get('password') || '', 'base64').toString()
const fetchApi = (path, init = {}) => fetch(new URL(path, baseUrl), init)
const fetchAuth = (path, init = {}) => fetchApi(path, { ...init, headers: { ...(init.headers || {}), 'cookie': getToken() } })

const isLoggedIn = async () => {
  if (!hasToken()) return false
  const res = await (await fetchAuth('')).text()
  return res.includes('/OnlineJudge/profile')
}

class WrongCredentials extends Error {}
class NotAuthenticated extends Error {}
const tryLogIn = async (username, password) => {
  const res = await fetchApi('login', { body: new URLSearchParams({ username, password, next: '/' }), method: 'POST' })
  if (res.status !== 200) throw new Error(`network error: login request responded with status ${res.status}.`)
  const resText = await res.text()
  if (resText === '-1') throw new WrongCredentials()
  if (resText === '0') config.set('loginId', res.headers.get('set-cookie').split(';')[0])
  else throw new Error(`network error: login request responded with unknown response: ${resText}`)
}
const relogin = async () => {
  try {
    await tryLogIn(getUsername(), getPassword())
    console.log(`${SUCCESS} successfully signed in as ${green(getUsername())}. use ${blue('-f')} to sign in to a different account.`)
    return
  } catch (e) {
    console.log(e instanceof WrongCredentials ? `${ERROR} wrong credentials. did you change your password?` : `${ERROR} network error: ${e && e.stack || e}`)
    abort()
  }
}
const hasCredentials = () => config.has('username') && config.has('password')

/// Returns the path of the nearest git repo.
const gitPath = () => {
  let cwd = process.cwd()
  while (!fs.readdirSync(cwd).includes('.git') && cwd !== '/') cwd = path.join(cwd, '..')
  return cwd === '/' ? null : cwd
}
const gitAcmojrcPath = (basePath = gitPath()) => basePath ? path.join(basePath, '.acmojrc') : null
const gitProblemId = () => JSON.parse(fs.readFileSync(gitAcmojrcPath()).toString()).problemId

const submitCode = async (problemId, code, lang = 'cpp') => {
  const res = await fetchAuth('submit?problem_id=' + encodeURIComponent(problemId), {
    body: new URLSearchParams({ code, lang, problem_id: problemId }),
    method: 'POST',
  })
  if (res.status === 302) throw new NotAuthenticated()
  if (res.status !== 200) throw new Error(`network error: submit request responded with status ${res.status}.`)
  if (await res.text() !== '0') throw new Error(`network error: submit request responded with unknown response: ${resText}`)
}
const getRepoUrl = () => {
  const cwd = gitPath()
  const { stdout, stderr, status } = spawnSync('git', [ 'remote', 'get-url', 'origin' ], { cwd })
  if (status !== 0) throw new Error(`error from git: ${stderr.toString()}`)
  return stdout.toString().trim().replace(/^git@([^:]+)[:/]/i, 'https://$1/').replace(/^https?:\/\/github.com\//i, 'https://hub.fastgit.org/')
}

const ensureLoggedInUi = async () => {
  if (!await isLoggedIn()) {
    if (!config.get('password')) {
      console.log(`${ERROR} you are not logged in. use ${blue('acmoj login')} to sign in.`)
      abort()
    }
    console.log(`${INFO} session expired. trying to sign you in...`)
    try {
      await tryLogIn(getUsername(), getPassword())
      console.log(`${SUCCESS} successfully signed in as ${green(getUsername())}.`)
      return
    } catch (e) {
      console.log(e instanceof WrongCredentials ? `${ERROR} wrong credentials. did you change your password?` : `${ERROR} network error: ${e && e.stack || e}`)
      abort()
    }
  }
}

const getSubmissionId = async (problemId, lang = '-1') => {
  if (lang === 'cpp') lang = '0'
  if (lang === 'git') lang = '1'
  if (lang === 'verilog') lang = '2'
  const res = await (await fetchAuth('status?' + new URLSearchParams({ submitter: getUsername(), problem_id: problemId, status: '-1', lang }))).text()
  const match = res.match(/<a href="\/OnlineJudge\/code\?submit_id=(\d+)">/)
  if (!match || !match[1]) throw new Error(`cannot parse status html`)
  return Number(match[1])
}

const parseStatus = status => status.match(/<span[^>]*>([^<]*)<\/span>/)[1]
const pollJudgeResults = async submissionId => {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const res = await (await fetchAuth('code?submit_id=' + encodeURIComponent(submissionId))).text()
    const table = res.slice(res.indexOf('<th>评测编号</th>'))
    const [ /* submissionId */, /* nickname */, /* problem */, status, time, mem, score ] = Array.from(table.matchAll(/<td>([^]+?)<\/td>/g)).map(match => match[1].trim())
    if (/Running & Judging|Pending/i.test(status)) continue
    return { status: parseStatus(status), time, mem, score }
  }
}

const statusColor = status => bold((({
  Accepted: () => green('Accepted!'),
  'Wrong Answer': red,
  'Compile Error': yellow,
  'Runtime Error': red,
  'Time Limit Exceeded': yellow,
  'Memory Limit Exceeded': yellow,
  'Memory Leak': magenta,
  'Disk Limit Exceeded': magenta,
})[status] || (x => x))(status))
const submitCodeUi = async (problemId, code, lang = 'cpp', filename = '') => {
  await ensureLoggedInUi()
  console.log(`${INFO} you are going to submit ${blue(filename || code)} for problem ${blue(problemId)}.`)
  if (!args.yes) {
    const { confirm } = await enquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: 'continue?',
      initial: true,
    })
    if (!confirm) abort()
  }
  try {
    await submitCode(problemId, code, lang)
  } catch (e) {
    if (e instanceof NotAuthenticated) console.log(`${ERROR} it seems you are logged out during submission. please retry.`)
    else console.log(`${ERROR} cannot submit code: ${e}`)
    abort()
  }
  let submissionId
  try {
    submissionId = await getSubmissionId(problemId, lang)
  } catch (e) {
    console.log(`${ERROR} error getting submission id for your submission: ${e}`)
    abort()
  }
  console.log(`${SUCCESS} code submitted as submission ${blue(submissionId)}. waiting for judge results...`)
  try {
    const { status, time, mem, score } = await pollJudgeResults(submissionId)
    console.log(`${INFO} your submission status is ${statusColor(status)}`)
    console.log(`${INFO} time: ${blue(time)}, mem: ${blue(mem)}, score: ${blue(score)}`)
    console.log(`${INFO} visit ${blue(new URL('code?submit_id=' + encodeURIComponent(submissionId), baseUrl))} to view details.`)
  } catch (e) {
    console.log(`${ERROR} cannot get submission status: ${e}`)
    abort()
  }
}

const abort = () => process.exit(1)

const commands = {
  async login () {
    if (!args.force && await isLoggedIn()) {
      console.log(`${SUCCESS} you are already signed in as ${green(getUsername())}. use ${blue('-f')} to force relogin.`)
      return
    }
    if (!args.force && hasCredentials()) return await relogin()
    if (args.remember) console.log(`${WARN} your password will be saved in plaintext on disk.`)
    const { username } = await enquirer.prompt({
      type: 'input',
      name: 'username',
      message: 'ACMOJ username?',
      initial: config.get('username') || '',
    })
    if (!/^[a-zA_Z0-9_]+$/i.test(username)) {
      console.log(`${ERROR} invalid username "${username}"`)
      abort()
    }
    const { password } = await enquirer.prompt({
      type: 'password',
      name: 'password',
      message: 'ACMOJ password?' + (config.has('password') ? ' (leave blank to use remembered password)' : ''),
      initial: getPassword(),
    })
    console.log(`${INFO} trying to sign you in...`)
    try {
      await tryLogIn(username, password)
      config.set('username', username)
      if (args.remember) config.set('password', Buffer.from(password).toString('base64'))
      else config.delete('password')
      console.log(`${SUCCESS} successfully signed in as ${green(username)}.`)
    } catch (e) {
      console.log(e instanceof WrongCredentials ? `${ERROR} wrong credentials.` : `${ERROR} network error: ${e && e.stack || e}`)
      abort()
    }
  },
  async logout () {
    if (!await isLoggedIn()) return console.log(`${SUCCESS} you are not logged in. no need to sign out.`)
    try {
      const res = await fetchAuth('logout')
      if (res.status !== 302 && res.status !== 200) {
        console.log(`${ERROR} log out request responded with unknown status ${res.status}`)
        abort()
      }
      config.delete('loginId')
      console.log(`${SUCCESS} successfully signed out.`)
    } catch (e) {
      console.log(`${ERROR} network error: ${e}`)
      abort()
    }
  },
  async submit () {
    if (!args.problemId) {
      const rcPath = gitAcmojrcPath()
      if (!rcPath) {
        console.log(`${ERROR} please specify a problem id to submit.`)
        yargs.showHelp()
        abort()
      }
      if (!fs.existsSync(rcPath)) {
        console.log(`${ERROR} please specify a problem id to submit.`)
        yargs.showHelp()
        console.log(`${INFO} to submit a git repository, use ${blue('acmoj git <problemId>')} to configure the git repository first.`)
        abort()
      }
      let problemId
      try {
        problemId = gitProblemId()
      } catch (e) {
        console.log(`${ERROR} unable to read configuration file: ${red(e)}. try removing the file at ${blue(rcPath)}.`)
        abort()
      }
      let repoUrl
      try {
        repoUrl = getRepoUrl()
      } catch (e) {
        console.log(`${ERROR} ${e}`)
        abort()
      }
      console.log(`${WARN} please be sure to commit and push your code before you submit.`)
      await submitCodeUi(problemId, repoUrl, 'git')
      return
    }
    const { problemId } = args
    if (gitPath()) {
      console.log(`${INFO} you are in a git repository, but you are going to submit a C++ file. use ${blue('acmoj git <problemId>')} to set up submission for a git repository.`)
    }
    if (!args.sourceFile) {
      const possibleLocations = [ `${problemId}.hpp`, `src/${problemId}.hpp`, `${problemId}.h`, `src/${problemId}.h`, `${problemId}.cpp`, `src/${problemId}.cpp`, 'main.cpp' ]
      for (const source of possibleLocations) {
        if (fs.existsSync(source)) {
          args.sourceFile = source
          break
        }
      }
      if (!args.sourceFile) {
        console.log(`${ERROR} cannot determine where is your source file. have tried: ${possibleLocations.map(green).join(', ')}`)
        abort()
      }
    }
    const { sourceFile } = args
    if (!fs.existsSync(sourceFile)) {
      console.log(`${ERROR} source file ${red(sourceFile)} does not exist.`)
      abort()
    }
    let code
    try {
      code = fs.readFileSync(sourceFile).toString()
    } catch (e) {
      console.log(`${ERROR} cannot read source file: ${e}`)
      abort()
    }
    await submitCodeUi(problemId, code, 'cpp', sourceFile)
  },
  async git () {
    const rcPath = gitAcmojrcPath()
    if (!rcPath) {
      console.log(`${ERROR} not in a git repository. use ${blue('git init')} to initialize one.`)
      abort()
    }
    if (fs.existsSync(rcPath)) {
      if (!args.yes) {
        console.log(`${INFO} this git repository is configured to submit to problem ${blue(gitProblemId())}.`)
        const { confirm } = await enquirer.prompt({
          type: 'confirm',
          name: 'confirm',
          message: 'override?',
        })
        if (!confirm) abort()
      } else console.log(`${WARN} overriding config file as it is configured to submit to problem ${blue(gitProblemId())}.`)
    }
    try {
      fs.writeFileSync(rcPath, JSON.stringify({ problemId: args.problemId }, null, 2) + '\n')
    } catch (e) {
      console.log(`${ERROR} cannot write configuration file: ${e}`)
      abort()
    }
    console.log(`${SUCCESS} created config file at ${rcPath}. you should include this file in your version control.`)
  },
}

commands[args._[0]]().catch(e => {
  console.log(`${ERROR} unexpected error: ${e}`)
  process.exit(1)
})
