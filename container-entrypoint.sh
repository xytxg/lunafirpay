#!/bin/sh
set -eu

node /app/scripts/provision-db-user.js
exec node app.js
