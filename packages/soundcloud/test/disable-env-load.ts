import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'

process.loadEnvFile = () => {}
syncBuiltinESMExports()
