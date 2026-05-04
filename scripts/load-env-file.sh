#!/usr/bin/env bash

# Load KEY=VALUE pairs from a dotenv file into the current shell.
# Existing shell environment values win over values in the file.
# This helper intentionally does not print values because the file may contain secrets.

load_env_file() {
  local env_file="${1:-.env}"

  if [[ ! -f "${env_file}" ]]; then
    return 0
  fi

  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    local line="${raw_line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"

    if [[ -z "${line}" || "${line}" == \#* ]]; then
      continue
    fi

    if [[ "${line}" == export\ * ]]; then
      line="${line#export }"
      line="${line#"${line%%[![:space:]]*}"}"
    fi

    if [[ "${line}" != *=* ]]; then
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi

    if [[ -n "${!key+x}" ]]; then
      continue
    fi

    if [[ "${value}" == \"*\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
      value="${value//\\n/$'\n'}"
      value="${value//\\r/$'\r'}"
      value="${value//\\t/$'\t'}"
      value="${value//\\\"/\"}"
      value="${value//\\\\/\\}"
    elif [[ "${value}" == \'*\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    else
      value="${value%% #*}"
    fi

    export "${key}=${value}"
  done < "${env_file}"
}
