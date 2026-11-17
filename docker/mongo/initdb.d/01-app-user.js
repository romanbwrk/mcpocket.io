// Runs ONCE, when the MongoDB data volume is first initialised (official image
// /docker-entrypoint-initdb.d hook, as the root user). Creates the
// least-privilege account MCPocket connects with: readWrite on its own
// database only. Later changes to MONGO_APP_* are NOT applied automatically —
// update the user by hand (db.updateUser) or recreate the volume.
const dbName = process.env.MONGODB_DB || "mcpocket"
const user = process.env.MONGO_APP_USERNAME || "mcpocket"
const pwd = process.env.MONGO_APP_PASSWORD

if (!pwd) throw new Error("MONGO_APP_PASSWORD is not set")

const appDb = db.getSiblingDB(dbName)
if (appDb.getUser(user)) {
  print(`MongoDB user "${user}" already exists on "${dbName}"`)
} else {
  appDb.createUser({ user, pwd, roles: [{ role: "readWrite", db: dbName }] })
  print(`Created MongoDB user "${user}" (readWrite on "${dbName}")`)
}
