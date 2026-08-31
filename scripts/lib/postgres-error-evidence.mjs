import { createHash } from "node:crypto";

const sqlStatePattern = /^[0-9A-Z]{5}$/u;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/u;
const ansiSgrPattern = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;]*m`,
  "gu",
);
const postgresDiagnosticOrder = new Map([
  ["DETAIL", 0],
  ["SCHEMA NAME", 1],
  ["TABLE NAME", 2],
  ["COLUMN NAME", 3],
  ["DATA TYPE NAME", 4],
  ["CONSTRAINT NAME", 5],
  ["CONTEXT", 6],
  ["LOCATION", 7],
]);

function ansiNormalized(output) {
  return output.replace(ansiSgrPattern, "");
}

function hasUnsafeControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    )
      return true;
  }
  return false;
}

function canonicalStream(output) {
  let normalized = ansiNormalized(String(output ?? ""));
  if (hasUnsafeControl(normalized)) return null;
  normalized = normalized.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return null;
  if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
  if (!normalized || normalized.endsWith("\n")) return null;
  return normalized;
}

function validExpectedValue(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\r\n]/u.test(value) &&
    !hasUnsafeControl(value)
  );
}

function hasDiagnosticSpoof(value) {
  return /(?:^|[\t ])(?:ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT|LOCATION|SCHEMA NAME|TABLE NAME|COLUMN NAME|DATA TYPE NAME|CONSTRAINT NAME|psql):/iu.test(
    value,
  );
}

function hasPostgresMetaOutput(stdout) {
  const source = String(stdout ?? "");
  if (!source) return false;
  const normalized = canonicalStream(source);
  if (normalized === null) return true;
  return /(?:^|\n)[\t ]*(?:ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT|LOCATION|SCHEMA NAME|TABLE NAME|COLUMN NAME|DATA TYPE NAME|CONSTRAINT NAME|psql):/imu.test(
    normalized,
  );
}

function parseLocation(value) {
  const match =
    /^(?<routine>[A-Za-z_][A-Za-z0-9_$]*),[\t ]+(?<file>[A-Za-z0-9_.-]{1,128}):(?<line>[1-9][0-9]{0,8})$/u.exec(
      value,
    );
  if (!match?.groups) return null;
  return Object.freeze({
    routine: match.groups.routine,
    file: match.groups.file,
    line: Number(match.groups.line),
  });
}

function parsePlpgsqlContextFrame(value) {
  const match =
    /^PL\/pgSQL function (?<routine>(?:[A-Za-z_][A-Za-z0-9_$]*\.)?(?:[A-Za-z_][A-Za-z0-9_$]*\((?:[A-Za-z_][A-Za-z0-9_$]*(?:\[\])?(?:,[\t ]*[A-Za-z_][A-Za-z0-9_$]*(?:\[\])?)*)?\)|inline_code_block)) line (?<line>[1-9][0-9]{0,6}) at (?<operation>[A-Za-z][A-Za-z ]{0,63})$/u.exec(
      value,
    );
  if (!match?.groups) return null;
  const operation = match.groups.operation.trimEnd();
  if (operation !== match.groups.operation || !validExpectedValue(operation))
    return null;
  return Object.freeze({
    routine: match.groups.routine.replace(/,[\t ]+/gu, ","),
    line: Number(match.groups.line),
    operation,
  });
}

function parsePostgresContext(lines) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 256)
    return null;
  const frames = [];
  let index = 0;
  while (index < lines.length) {
    const frame = parsePlpgsqlContextFrame(lines[index]);
    if (frame === null) return null;
    index += 1;
    let statementSha256 = null;
    if (index < lines.length) {
      if (!lines[index].startsWith('SQL statement "')) return null;
      const statementStart = index;
      while (
        index < lines.length &&
        parsePlpgsqlContextFrame(lines[index]) === null
      ) {
        if (
          !validExpectedValue(lines[index]) ||
          /^(?:ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT|LOCATION|SCHEMA NAME|TABLE NAME|COLUMN NAME|DATA TYPE NAME|CONSTRAINT NAME|psql):/iu.test(
            lines[index],
          )
        )
          return null;
        index += 1;
      }
      if (
        index === statementStart ||
        index === lines.length ||
        !lines[index - 1].endsWith('"')
      )
        return null;
      statementSha256 = createHash("sha256")
        .update(lines.slice(statementStart, index).join("\n"), "utf8")
        .digest("hex");
    }
    frames.push(Object.freeze({ ...frame, statementSha256 }));
  }
  return Object.freeze({
    frames: Object.freeze(frames),
    primary: frames[0],
  });
}

function parsePostgresErrorEnvelope(stderr, expectedInputSource) {
  const normalized = canonicalStream(stderr);
  if (normalized === null) return null;
  const lines = normalized.split("\n");
  if (
    expectedInputSource !== undefined &&
    (typeof expectedInputSource !== "string" ||
      expectedInputSource.length === 0 ||
      expectedInputSource.length > 4_096 ||
      /[\0\r\n]/u.test(expectedInputSource))
  )
    return null;
  const acceptedInputSource =
    expectedInputSource === undefined ? "<stdin>" : expectedInputSource;
  const header = new RegExp(
    `^(?:(?<framing>psql:(?<inputSource>${regexLiteral(acceptedInputSource)}):(?<inputLine>[1-9][0-9]{0,8}):)[\\t ]+)?ERROR:(?<body>[\\t ].*)$`,
    "u",
  ).exec(lines[0]);
  if (!header?.groups) return null;
  if (
    expectedInputSource !== undefined &&
    header.groups.inputSource !== expectedInputSource
  )
    return null;
  const parsedBody =
    /^(?:(?<sqlState>[0-9A-Z]{5}):[\t ]+)?(?<message>.+)$/u.exec(
      header.groups.body.trimStart(),
    );
  const message = parsedBody?.groups?.message;
  if (
    header.groups.body !== header.groups.body.trimEnd() ||
    !message ||
    message !== message.trimEnd() ||
    hasDiagnosticSpoof(message)
  )
    return null;

  const diagnostics = {};
  let priorOrder = -1;
  let context = null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const diagnostic = /^(?<field>[A-Z][A-Z ]*):[\t ]+(?<value>.+)$/u.exec(
      line,
    );
    const field = diagnostic?.groups?.field;
    const rawValue = diagnostic?.groups?.value;
    const value = rawValue?.trimStart();
    const order = postgresDiagnosticOrder.get(field);
    if (
      field === undefined ||
      order === undefined ||
      order <= priorOrder ||
      Object.hasOwn(diagnostics, field) ||
      rawValue !== rawValue?.trimEnd() ||
      !validExpectedValue(value) ||
      hasDiagnosticSpoof(value)
    )
      return null;
    if (field === "CONTEXT") {
      const contextLines = [value];
      while (
        index + 1 < lines.length &&
        !/^[A-Z][A-Z ]*:[\t ]+/u.test(lines[index + 1])
      ) {
        index += 1;
        contextLines.push(lines[index]);
      }
      context = parsePostgresContext(contextLines);
      if (context === null) return null;
      diagnostics[field] = contextLines.join("\n");
      priorOrder = order;
      continue;
    }
    if (field === "LOCATION" && parseLocation(value) === null) return null;
    if (
      field !== "DETAIL" &&
      field !== "LOCATION" &&
      !identifierPattern.test(value)
    )
      return null;
    diagnostics[field] = value;
    priorOrder = order;
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    framing:
      header.groups.framing === undefined
        ? null
        : Object.freeze({
            inputLine: Number(header.groups.inputLine),
            inputSource: header.groups.inputSource,
          }),
    location:
      diagnostics.LOCATION === undefined
        ? null
        : parseLocation(diagnostics.LOCATION),
    context,
    message,
    sqlState: parsedBody?.groups?.sqlState ?? null,
  });
}

function regexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseForeignKeyMessage(message, expectedConstraint) {
  if (
    !validExpectedValue(expectedConstraint) ||
    expectedConstraint.includes('"')
  )
    return null;
  const relation = '"(?<relation>(?:""|[^"\\r\\n])*)"';
  const otherRelation = '"(?<otherRelation>(?:""|[^"\\r\\n])*)"';
  const constraint = regexLiteral(expectedConstraint);
  const insert = new RegExp(
    `^insert or update on table ${relation} violates foreign key constraint "${constraint}"$`,
    "u",
  ).exec(message);
  const deletion = new RegExp(
    `^update or delete on table ${relation} violates foreign key constraint "${constraint}" on table ${otherRelation}$`,
    "u",
  ).exec(message);
  const match = insert ?? deletion;
  if (!match?.groups) return null;
  return Object.freeze({
    kind: insert === null ? "delete" : "insert",
    relation: match.groups.relation.replaceAll('""', '"'),
    otherRelation: match.groups.otherRelation?.replaceAll('""', '"') ?? null,
  });
}

function parseForeignKeyDetail(value) {
  const insertion =
    /^Key \(.{1,512}\)=\(.{1,4096}\) is not present in table "(?<table>(?:""|[^"\r\n])+)"\.$/u.exec(
      value ?? "",
    );
  const deletion =
    /^Key \(.{1,512}\)=\(.{1,4096}\) is still referenced from table "(?<table>(?:""|[^"\r\n])+)"\.$/u.exec(
      value ?? "",
    );
  const match = insertion ?? deletion;
  if (!match?.groups?.table) return null;
  return Object.freeze({
    kind: insertion === null ? "delete" : "insert",
    table: match.groups.table.replaceAll('""', '"'),
  });
}

function parseUniqueMessage(message, expectedConstraint) {
  if (!validExpectedValue(expectedConstraint)) return false;
  return (
    message ===
    `duplicate key value violates unique constraint "${expectedConstraint}"`
  );
}

function parseCheckMessage(message, expectedConstraint) {
  if (
    !validExpectedValue(expectedConstraint) ||
    expectedConstraint.includes('"')
  )
    return null;
  const relation = '"(?<relation>(?:""|[^"\\r\\n])*)"';
  const constraint = regexLiteral(expectedConstraint);
  const match = new RegExp(
    `^new row for relation ${relation} violates check constraint "${constraint}"$`,
    "u",
  ).exec(message);
  if (!match?.groups?.relation) return null;
  return Object.freeze({
    relation: match.groups.relation.replaceAll('""', '"'),
  });
}

function canonicalUniqueDetail(value) {
  return /^Key \(.{1,512}\)=\(.{1,4096}\) already exists\.$/u.test(value ?? "");
}

function canonicalCheckDetail(value) {
  return /^Failing row contains \(.{1,8192}\)\.$/u.test(value ?? "");
}

function diagnosticsMatchExpected(envelope, expected, constraintIdentity) {
  const fields = Object.keys(envelope.diagnostics);
  if (constraintIdentity?.kind === "foreign-key") {
    const foreignKey = constraintIdentity.identity;
    const expectedTable =
      foreignKey.kind === "insert"
        ? foreignKey.relation
        : foreignKey.otherRelation;
    const detail = parseForeignKeyDetail(envelope.diagnostics.DETAIL);
    const detailTable = detail?.table ?? null;
    const referencedTable =
      foreignKey.kind === "insert" ? detailTable : foreignKey.relation;
    if (envelope.diagnostics["CONSTRAINT NAME"] !== expected.constraint)
      return false;
    if (
      fields.length !== 5 ||
      fields[0] !== "DETAIL" ||
      fields[1] !== "SCHEMA NAME" ||
      fields[2] !== "TABLE NAME" ||
      fields[3] !== "CONSTRAINT NAME" ||
      fields[4] !== "LOCATION" ||
      detailTable === null ||
      detail?.kind !== foreignKey.kind ||
      !validExpectedValue(expected.schema) ||
      !validExpectedValue(expected.table) ||
      !validExpectedValue(expected.referencedTable) ||
      envelope.diagnostics["SCHEMA NAME"] !== expected.schema ||
      expectedTable === null ||
      expectedTable !== expected.table ||
      referencedTable !== expected.referencedTable ||
      envelope.diagnostics["TABLE NAME"] !== expected.table ||
      (foreignKey.kind === "delete" && detailTable !== foreignKey.otherRelation)
    )
      return false;
  } else if (constraintIdentity?.kind === "unique") {
    if (
      fields.length !== 5 ||
      fields[0] !== "DETAIL" ||
      fields[1] !== "SCHEMA NAME" ||
      fields[2] !== "TABLE NAME" ||
      fields[3] !== "CONSTRAINT NAME" ||
      fields[4] !== "LOCATION" ||
      !canonicalUniqueDetail(envelope.diagnostics.DETAIL) ||
      envelope.diagnostics["SCHEMA NAME"] !== (expected.schema ?? "public") ||
      envelope.diagnostics["TABLE NAME"] !== expected.table ||
      envelope.diagnostics["CONSTRAINT NAME"] !== expected.constraint
    )
      return false;
  } else if (constraintIdentity?.kind === "check") {
    if (
      fields.length !== 5 ||
      fields[0] !== "DETAIL" ||
      fields[1] !== "SCHEMA NAME" ||
      fields[2] !== "TABLE NAME" ||
      fields[3] !== "CONSTRAINT NAME" ||
      fields[4] !== "LOCATION" ||
      !canonicalCheckDetail(envelope.diagnostics.DETAIL) ||
      envelope.diagnostics["SCHEMA NAME"] !== expected.schema ||
      envelope.diagnostics["TABLE NAME"] !== expected.table ||
      envelope.diagnostics["CONSTRAINT NAME"] !== expected.constraint ||
      constraintIdentity.identity.relation !== expected.table
    )
      return false;
  } else if (expected.context !== undefined) {
    const expectedFrames = expected.context;
    if (
      fields.length !== 2 ||
      fields[0] !== "CONTEXT" ||
      fields[1] !== "LOCATION" ||
      !Array.isArray(expectedFrames) ||
      expectedFrames.length === 0 ||
      expectedFrames.length > 16 ||
      expectedFrames.some(
        (frame) =>
          !frame ||
          typeof frame !== "object" ||
          !onlyKeys(
            frame,
            new Set(["routine", "line", "operation", "statementSha256"]),
          ) ||
          !validExpectedValue(frame.routine) ||
          !Number.isSafeInteger(frame.line) ||
          frame.line <= 0 ||
          frame.line > 1_000_000 ||
          !validExpectedValue(frame.operation) ||
          (frame.statementSha256 !== undefined &&
            !/^[a-f0-9]{64}$/u.test(frame.statementSha256)),
      ) ||
      envelope.context?.frames?.length !== expectedFrames.length ||
      expectedFrames.some((frame, index) => {
        const observed = envelope.context.frames[index];
        return (
          observed.routine !== frame.routine ||
          observed.line !== frame.line ||
          observed.operation !== frame.operation ||
          observed.statementSha256 !== (frame.statementSha256 ?? null)
        );
      })
    )
      return false;
  } else if (fields.length !== 1 || fields[0] !== "LOCATION") {
    return false;
  }
  if (
    !validExpectedValue(expected.routine) ||
    envelope.location?.routine !== expected.routine
  )
    return false;
  return true;
}

function envelopeMatchesExpectedEvidence(envelope, expected) {
  if (
    !envelope ||
    !expected ||
    typeof expected !== "object" ||
    !onlyKeys(
      expected,
      new Set([
        "sqlState",
        "message",
        "constraint",
        "routine",
        "schema",
        "table",
        "referencedTable",
        "context",
      ]),
    )
  )
    return false;
  if (
    !sqlStatePattern.test(expected.sqlState ?? "") ||
    envelope.sqlState !== expected.sqlState ||
    !validExpectedValue(expected.routine)
  )
    return false;
  if (
    expected.message !== undefined &&
    (!validExpectedValue(expected.message) ||
      envelope.message !== expected.message)
  )
    return false;
  let constraintIdentity = null;
  if (expected.constraint !== undefined) {
    if (
      !validExpectedValue(expected.constraint) ||
      expected.context !== undefined
    )
      return false;
    if (expected.sqlState === "23503") {
      const foreignKey = parseForeignKeyMessage(
        envelope.message,
        expected.constraint,
      );
      if (foreignKey === null || expected.routine !== "ri_ReportViolation")
        return false;
      constraintIdentity = Object.freeze({
        kind: "foreign-key",
        identity: foreignKey,
      });
    } else if (expected.sqlState === "23505") {
      if (
        !parseUniqueMessage(envelope.message, expected.constraint) ||
        !validExpectedValue(expected.schema) ||
        !validExpectedValue(expected.table) ||
        expected.referencedTable !== undefined ||
        expected.routine !== "_bt_check_unique"
      )
        return false;
      constraintIdentity = Object.freeze({ kind: "unique" });
    } else if (expected.sqlState === "23514") {
      const check = parseCheckMessage(envelope.message, expected.constraint);
      if (
        check === null ||
        !validExpectedValue(expected.schema) ||
        !validExpectedValue(expected.table) ||
        expected.referencedTable !== undefined ||
        expected.routine !== "ExecConstraints"
      )
        return false;
      constraintIdentity = Object.freeze({ kind: "check", identity: check });
    } else {
      return false;
    }
  } else if (expected.sqlState === "23503") {
    return false;
  } else if (expected.message === undefined) {
    return false;
  } else if (
    expected.schema !== undefined ||
    expected.table !== undefined ||
    expected.referencedTable !== undefined
  ) {
    return false;
  }
  return diagnosticsMatchExpected(envelope, expected, constraintIdentity);
}

function expectedFailureEvidence(expectedFailure) {
  return typeof expectedFailure === "object" && expectedFailure !== null
    ? expectedFailure
    : null;
}

function envelopeMatchesExpectedFailure(envelope, expectedFailure) {
  const expected = expectedFailureEvidence(expectedFailure);
  return (
    expected !== null && envelopeMatchesExpectedEvidence(envelope, expected)
  );
}

function validFailureProcess(result) {
  return Boolean(
    result &&
    !postgresProcessTimedOut(result) &&
    Number.isSafeInteger(result.status) &&
    result.status > 0 &&
    result.status <= 255 &&
    result.signal == null &&
    result.error == null &&
    !hasPostgresMetaOutput(result.stdout),
  );
}

function normalizePrismaConstraint(value) {
  if (validExpectedValue(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    validExpectedValue(value.index)
  )
    return value.index;
  return null;
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function prismaDriverAdapterEnvelope(driverAdapter, prismaCode) {
  if (
    !driverAdapter ||
    typeof driverAdapter !== "object" ||
    driverAdapter.name !== "DriverAdapterError" ||
    !driverAdapter.cause ||
    typeof driverAdapter.cause !== "object"
  )
    return null;
  const cause = driverAdapter.cause;
  if (
    !sqlStatePattern.test(cause.originalCode ?? "") ||
    !validExpectedValue(cause.originalMessage)
  )
    return null;

  if (prismaCode === "P2003") {
    const constraint = normalizePrismaConstraint(cause.constraint);
    if (
      !onlyKeys(
        cause,
        new Set(["kind", "originalCode", "originalMessage", "constraint"]),
      ) ||
      cause.kind !== "ForeignKeyConstraintViolation" ||
      cause.originalCode !== "23503" ||
      !constraint ||
      parseForeignKeyMessage(cause.originalMessage, constraint) === null
    )
      return null;
    return Object.freeze({
      message: cause.originalMessage,
      sqlState: cause.originalCode,
      constraint,
    });
  }

  if (
    (prismaCode !== "P2010" && prismaCode !== null) ||
    !onlyKeys(
      cause,
      new Set([
        "kind",
        "originalCode",
        "originalMessage",
        "code",
        "severity",
        "message",
        "detail",
        "column",
        "hint",
      ]),
    ) ||
    cause.kind !== "postgres" ||
    cause.code !== cause.originalCode ||
    cause.message !== cause.originalMessage ||
    cause.severity !== "ERROR" ||
    cause.detail !== undefined ||
    cause.column !== undefined ||
    cause.hint !== undefined
  )
    return null;
  return Object.freeze({
    message: cause.originalMessage,
    sqlState: cause.originalCode,
    constraint: null,
  });
}

function prismaPostgresEnvelopes(error) {
  if (!error || typeof error !== "object") return [];
  if (error.name === "DriverAdapterError") {
    const envelope = prismaDriverAdapterEnvelope(error, null);
    return envelope ? [envelope] : [];
  }
  if (error.code !== "P2010" && error.code !== "P2003") return [];
  const meta = error.meta;
  if (
    !meta ||
    typeof meta !== "object" ||
    !onlyKeys(meta, new Set(["driverAdapterError"]))
  )
    return [];
  const envelope = prismaDriverAdapterEnvelope(
    meta.driverAdapterError,
    error.code,
  );
  return envelope ? [envelope] : [];
}

function validPrismaContext(context) {
  return Boolean(
    context &&
    typeof context === "object" &&
    onlyKeys(
      context,
      new Set(["language", "schema", "routine", "line", "operation"]),
    ) &&
    context.language === "PL/pgSQL" &&
    context.schema === "public" &&
    validExpectedValue(context.routine) &&
    Number.isSafeInteger(context.line) &&
    context.line > 0 &&
    context.line <= 1_000_000 &&
    validExpectedValue(context.operation),
  );
}

function validObservedPostgresEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    onlyKeys(
      value,
      new Set([
        "sqlState",
        "severity",
        "message",
        "constraint",
        "schema",
        "table",
        "referencedTable",
        "routine",
        "context",
      ]),
    ) &&
    sqlStatePattern.test(value.sqlState ?? "") &&
    value.severity === "ERROR" &&
    validExpectedValue(value.message) &&
    validExpectedValue(value.routine) &&
    (value.constraint === null || validExpectedValue(value.constraint)) &&
    (value.schema === null || validExpectedValue(value.schema)) &&
    (value.table === null || validExpectedValue(value.table)) &&
    (value.referencedTable === null ||
      validExpectedValue(value.referencedTable)) &&
    (value.context === null || validPrismaContext(value.context)),
  );
}

function contextMatchesExpected(context, expected) {
  if (expected === null) return context === null;
  return Boolean(
    validPrismaContext(context) &&
    expected &&
    typeof expected === "object" &&
    onlyKeys(expected, new Set(["schema", "routine", "line", "operation"])) &&
    expected.schema === "public" &&
    validExpectedValue(expected.routine) &&
    Number.isSafeInteger(expected.line) &&
    expected.line > 0 &&
    expected.line <= 1_000_000 &&
    validExpectedValue(expected.operation) &&
    context.routine === expected.routine &&
    context.line === expected.line &&
    context.operation === expected.operation,
  );
}

export function hasCanonicalPrismaPostgresErrorEvidence(
  error,
  expected,
  observations,
) {
  const envelopes = prismaPostgresEnvelopes(error);
  if (
    envelopes.length !== 1 ||
    !expected ||
    typeof expected !== "object" ||
    !onlyKeys(
      expected,
      new Set([
        "sqlState",
        "message",
        "constraint",
        "schema",
        "table",
        "referencedTable",
        "routine",
        "context",
      ]),
    ) ||
    !sqlStatePattern.test(expected.sqlState ?? "") ||
    (expected.message !== undefined && !validExpectedValue(expected.message)) ||
    (expected.constraint === undefined &&
      !validExpectedValue(expected.message)) ||
    !validExpectedValue(expected.routine) ||
    !Object.hasOwn(expected, "context") ||
    !Array.isArray(observations) ||
    observations.length !== 1 ||
    !validObservedPostgresEnvelope(observations[0])
  )
    return false;
  const envelope = envelopes[0];
  const observed = observations[0];
  if (expected.sqlState === "23503" && expected.constraint === undefined)
    return false;
  if (
    envelope.sqlState !== expected.sqlState ||
    (expected.message !== undefined && envelope.message !== expected.message) ||
    observed.sqlState !== envelope.sqlState ||
    observed.message !== envelope.message ||
    observed.routine !== expected.routine ||
    !contextMatchesExpected(observed.context, expected.context)
  )
    return false;
  if (expected.constraint !== undefined) {
    return Boolean(
      expected.sqlState === "23503" &&
      validExpectedValue(expected.constraint) &&
      validExpectedValue(expected.schema) &&
      validExpectedValue(expected.table) &&
      validExpectedValue(expected.referencedTable) &&
      envelope.constraint === expected.constraint &&
      observed.constraint === expected.constraint &&
      observed.schema === expected.schema &&
      observed.table === expected.table &&
      observed.referencedTable === expected.referencedTable &&
      observed.routine === "ri_ReportViolation" &&
      expected.routine === "ri_ReportViolation" &&
      expected.context === null &&
      observed.context === null &&
      (() => {
        const identity = parseForeignKeyMessage(
          envelope.message,
          expected.constraint,
        );
        return Boolean(
          identity !== null &&
          (identity.kind === "insert"
            ? identity.relation === expected.table
            : identity.otherRelation === expected.table &&
              identity.relation === expected.referencedTable),
        );
      })(),
    );
  }
  if (
    expected.schema !== undefined ||
    expected.table !== undefined ||
    expected.referencedTable !== undefined
  )
    return false;
  return (
    envelope.constraint === null &&
    observed.constraint === null &&
    observed.schema === null &&
    observed.table === null &&
    observed.referencedTable === null
  );
}

export function hasCanonicalPostgresErrorEvidence(result, expected) {
  return (
    validFailureProcess(result) &&
    expected &&
    typeof expected === "object" &&
    sqlStatePattern.test(expected.sqlState ?? "") &&
    envelopeMatchesExpectedEvidence(
      parsePostgresErrorEnvelope(result.stderr, result.postgresInputSource),
      expected,
    )
  );
}

const prismaMigrationProse =
  "A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve";

function parseRustQuoted(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parsePrismaDbError(line) {
  const match =
    /^DbError \{ severity: "ERROR", parsed_severity: Some\(Error\), code: SqlState\(E(?<sqlState>[0-9A-Z]{5})\), message: (?<message>"(?:\\.|[^"\\])*"), detail: None, hint: None, position: None, where_: None, schema: None, table: None, column: None, datatype: None, constraint: None, file: Some\("[A-Za-z0-9_.-]{1,128}"\), line: Some\([1-9][0-9]{0,8}\), routine: Some\("(?<routine>[A-Za-z_][A-Za-z0-9_$]*)"\) \}$/u.exec(
      line,
    );
  const message = match?.groups ? parseRustQuoted(match.groups.message) : null;
  if (!match?.groups || !validExpectedValue(message)) return null;
  return Object.freeze({
    message,
    routine: match.groups.routine,
    sqlState: match.groups.sqlState,
  });
}

function parsePrismaMigrationPostgresEnvelope(stderr) {
  const normalized = canonicalStream(stderr);
  if (normalized === null) return null;
  const lines = normalized.split("\n");
  // Prisma 7 has two deterministic renderings: the direct engine form is
  // compact, while the CLI wrapper inserts blank section separators. Reject
  // every other layout rather than accepting a bag of familiar lines.
  const semanticLines =
    lines.length === 7
      ? lines
      : lines.length === 12 &&
          lines[1] === "" &&
          lines[3] === "" &&
          lines[5] === "" &&
          lines[7] === "" &&
          lines[10] === ""
        ? [
            lines[0],
            lines[2],
            lines[4],
            lines[6],
            lines[8],
            lines[9],
            lines[11],
          ]
        : null;
  if (
    semanticLines === null ||
    !/^(?:Error:[\t ]+)?P3018$/u.test(semanticLines[0]) ||
    semanticLines[1] !== prismaMigrationProse ||
    semanticLines[4] !== "Database error:"
  )
    return null;
  const migration = /^Migration name:[\t ]+([0-9]{6}_[a-z0-9_]{1,200})$/u.exec(
    semanticLines[2],
  );
  const code = /^Database error code:[\t ]+([0-9A-Z]{5})$/u.exec(
    semanticLines[3],
  );
  const error = /^ERROR:[\t ]+(.+)$/u.exec(semanticLines[5]);
  const dbError = parsePrismaDbError(semanticLines[6]);
  const message = error?.[1];
  if (
    !migration ||
    !code ||
    !message ||
    message !== message.trimEnd() ||
    !validExpectedValue(message) ||
    hasDiagnosticSpoof(message) ||
    dbError === null ||
    dbError.sqlState !== code[1] ||
    dbError.message !== message
  )
    return null;
  return Object.freeze({
    dbError,
    message,
    migrationName: migration[1],
    sqlState: code[1],
  });
}

export function hasCanonicalPrismaMigrationPostgresErrorEvidence(
  result,
  expected,
) {
  if (
    !validFailureProcess(result) ||
    /(?:^|\n)[\t ]*(?:Error:[\t ]+)?P3018(?:$|\n)|(?:^|\n)[\t ]*(?:Migration name|Database error(?: code)?|ERROR|FATAL|PANIC|DbError)[\t :]/mu.test(
      String(result.stdout ?? ""),
    ) ||
    !expected ||
    typeof expected !== "object" ||
    !onlyKeys(
      expected,
      new Set(["sqlState", "message", "migrationName", "routine"]),
    ) ||
    !sqlStatePattern.test(expected.sqlState ?? "") ||
    !validExpectedValue(expected.message) ||
    !/^[0-9]{6}_[a-z0-9_]{1,200}$/u.test(expected.migrationName ?? "") ||
    !identifierPattern.test(expected.routine ?? "")
  )
    return false;
  const envelope = parsePrismaMigrationPostgresEnvelope(result.stderr);
  return Boolean(
    envelope &&
    envelope.dbError &&
    envelope.sqlState === expected.sqlState &&
    envelope.message === expected.message &&
    envelope.migrationName === expected.migrationName &&
    envelope.dbError.routine === expected.routine,
  );
}

export function hasExactPostgresErrorEnvelope(
  stderr,
  expectedFailure,
  postgresInputSource,
) {
  return envelopeMatchesExpectedFailure(
    parsePostgresErrorEnvelope(stderr, postgresInputSource),
    expectedFailure,
  );
}

export function hasCanonicalPostgresSetLocalWarningPair(stderr) {
  const normalized = canonicalStream(stderr);
  if (normalized === null) return false;
  const lines = normalized.split("\n");
  if (lines.length !== 4) return false;
  for (let index = 0; index < lines.length; index += 2) {
    if (
      !/^WARNING:[\t ]+25P01:[\t ]+SET LOCAL can only be used in transaction blocks$/u.test(
        lines[index],
      ) ||
      !/^LOCATION:[\t ]+CheckTransactionBlock,[\t ]+xact\.c:[1-9][0-9]{0,8}$/u.test(
        lines[index + 1],
      )
    )
      return false;
  }
  return true;
}

export function hasCanonicalPostgresForeignKeyViolation(
  stderr,
  expectedIdentity,
) {
  if (
    !expectedIdentity ||
    typeof expectedIdentity !== "object" ||
    !onlyKeys(
      expectedIdentity,
      new Set(["constraint", "schema", "table", "referencedTable"]),
    )
  )
    return false;
  return envelopeMatchesExpectedEvidence(parsePostgresErrorEnvelope(stderr), {
    sqlState: "23503",
    constraint: expectedIdentity.constraint,
    schema: expectedIdentity.schema,
    table: expectedIdentity.table,
    referencedTable: expectedIdentity.referencedTable,
    routine: "ri_ReportViolation",
  });
}

export function hasCanonicalPostgresCheckViolation(stderr, expectedIdentity) {
  if (
    !expectedIdentity ||
    typeof expectedIdentity !== "object" ||
    !onlyKeys(expectedIdentity, new Set(["constraint", "schema", "table"]))
  )
    return false;
  return envelopeMatchesExpectedEvidence(parsePostgresErrorEnvelope(stderr), {
    sqlState: "23514",
    constraint: expectedIdentity.constraint,
    schema: expectedIdentity.schema,
    table: expectedIdentity.table,
    routine: "ExecConstraints",
  });
}

export function hasExpectedPostgresErrorEvidence(stderr, expectedFailure) {
  return hasExactPostgresErrorEnvelope(stderr, expectedFailure);
}

export function postgresProcessTimedOut(result) {
  return result?.timedOut === true || result?.error?.code === "ETIMEDOUT";
}

export function isCanonicalSilentProcessSuccess(result) {
  return Boolean(
    result &&
    result.status === 0 &&
    result.signal == null &&
    result.error == null &&
    String(result.stderr ?? "") === "",
  );
}

export function isPostgresFailureWithOneOfExactMessages(
  result,
  expectedFailures,
) {
  if (
    !validFailureProcess(result) ||
    !Array.isArray(expectedFailures) ||
    expectedFailures.length === 0
  )
    return false;
  const envelope = parsePostgresErrorEnvelope(
    result.stderr,
    result.postgresInputSource,
  );
  return expectedFailures.some((expectedFailure) =>
    envelopeMatchesExpectedFailure(envelope, expectedFailure),
  );
}

export function isPostgresFailureWithExactMessage(result, expectedFailure) {
  return isPostgresFailureWithOneOfExactMessages(result, [expectedFailure]);
}
