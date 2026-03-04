const fs = require('fs');
const mysql = require('mysql2/promise');
const yaml = require('js-yaml');

const configPath = '/app/config.yaml';

if (!fs.existsSync(configPath)) {
  throw new Error(`Missing config file: ${configPath}`);
}

const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
const database = config.database || {};

const host = database.host;
const port = Number(database.port || 3306);
const appUser = database.user;
const appPassword = database.password;
const appDatabase = database.database;
const rootPassword = process.env.DB_ROOT_PASSWORD || '';

if (!host || !appUser || !appPassword || !appDatabase) {
  throw new Error('Invalid database settings in /app/config.yaml');
}

if (!rootPassword) {
  throw new Error('DB_ROOT_PASSWORD is required');
}

const escSqlString = (value) => String(value).replace(/'/g, "''");
const escSqlIdentifier = (value) => String(value).replace(/`/g, '``');

const run = async () => {
  let conn;
  for (let i = 0; i < 30; i += 1) {
    try {
      conn = await mysql.createConnection({
        host,
        port,
        user: 'root',
        password: rootPassword,
      });
      break;
    } catch (err) {
      if (i === 29) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const user = escSqlString(appUser);
  const password = escSqlString(appPassword);
  const dbName = escSqlIdentifier(appDatabase);

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.query(`CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}'`);
  await conn.query(`ALTER USER '${user}'@'%' IDENTIFIED BY '${password}'`);
  await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${user}'@'%'`);
  await conn.query('FLUSH PRIVILEGES');
  await conn.end();
};

run().catch((err) => {
  console.error('[DB Provision] Failed:', err.message);
  process.exit(1);
});
