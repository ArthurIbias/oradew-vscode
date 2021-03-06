const fs = require("fs-extra");
const _ = require("lodash/fp");
const glob = require("glob");
const resolve = require("path").resolve;

const utils = require("./utility");
const db = require("./db");

let obj = {};

// Get array of files from output stream string
obj.fromStdoutToFilesArray = stdout =>
  _.pipe(
    // Generate array from lines
    utils.splitLines,
    // Remove empty items and duplicates
    _.compact,
    _.uniq,
    // Scripts first
    _.sortBy(_.identity),
    // Add ./ to path
    _.map(val => `./${val}`)
  )(stdout);

// Get array of files matched by glob patterns array
obj.fromGlobsToFilesArray = globArray => {
  return globArray.reduce((acc, path) => acc.concat(glob.sync(path)), []);
};

obj.exportFile = async (
  code,
  file,
  env,
  ease = false,
  getFunctionName,
  done
) => {
  const obj = utils.getDBObjectFromPath(file);
  const connCfg = db.getConfiguration(env, obj.owner);
  // Owner can change to default user
  obj.owner = connCfg.user.toUpperCase();

  let exported = null;
  let conn;
  try {
    conn = await db.getConnection(connCfg);
    // try {
    if (!ease || (await db.isDifferentDdlTime(conn, obj))) {
      // Get Db object code as string
      let lob = await db.getObjectDdl(conn, getFunctionName, obj);
      lob = _.pipe(
        // Remove whitespaces
        _.trim,
        // Remove NUL chars that are added to large files ?!
        _.replace(/\x00/g, ""),
        // Remove disable/enable line that is added at the end of the trigger
        _.replace(/\nALTER TRIGGER+.*/g, "")
      )(lob);
      // Return a value async with callback
      done(null, lob);
      // Mark object as exported
      await db.syncDdlTime(conn, obj);
      exported = true;
    } else {
      // Return local code to continue gulp pipe
      done(null, code);
      exported = false;
      //   }
      // } catch (error) {
      //   console.error(error.message);
    }
  } catch (error) {
    console.error(error.message);
    done(null, code);
    exported = false;
  } finally {
    conn && conn.close();
  }
  return { obj, exported };
};

function simpleParse(code) {
  // Trim empties and slash (/) from code if it exists
  code = _.pipe(
    _.trim,
    _.trimCharsEnd("/"),
    _.trim
  )(code);

  // Trim semicolon (;) if it doesn't end with "END;" or "END <name>; etc"
  if (!/END(\s\w*)*;$/gi.test(code)) {
    code = _.trimCharsEnd(";")(code);
  }
  return code;
}

function getLineAndPosition(code, offset) {
  let lines = utils.splitLines(code.substring(0, offset));
  let line = lines.length;
  let position = lines.pop().length + 1;
  return { line, position };
}

obj.compileFile = async (code, file, env, force = false, warnings) => {
  const obj = utils.getDBObjectFromPath(file);
  const connCfg = db.getConfiguration(env, obj.owner);
  obj.owner = connCfg.user.toUpperCase();

  code = simpleParse(code);

  // console.log(code);
  // console.log(code);
  let errors;
  let lines = [];
  let result = {};
  let conn;
  try {
    conn = await db.getConnection(connCfg);
    // Generate error if we havent the latest obj version
    // and we arent forcing compile
    if ((await db.isDifferentDdlTime(conn, obj)) && !force) {
      errors = db.getErrorObjectChanged();
    } else {
      // Otherwise compile object to Db with warning scope
      result = await db.compile(conn, code.toString(), warnings);
      // Mark object as exported as we have the latest version
      if (!force) await db.syncDdlTime(conn, obj);
      // Getting errors for this object from Db
      errors = await db.getErrors(conn, obj);
      lines = await db.getDbmsOutput(conn);
    }
  } catch (error) {
    const { line, position } = getLineAndPosition(code, error.offset);
    let msg = error.message;
    // console.log(msg);
    errors = db.getErrorSystem(msg, 1, line, position);
  } finally {
    conn && conn.close();
  }
  // Return results, errors array, file and env params
  return {
    obj,
    file,
    env,
    errors,
    result,
    lines
  };
};

obj.compileSelection = async (code, file, env, lineOffset) => {
  const obj = utils.getDBObjectFromPath(file);
  const connCfg = db.getConfiguration(env, obj.owner);
  obj.owner = connCfg.user.toUpperCase();

  code = simpleParse(code);

  let errors;
  let lines = [];
  let result = {};
  let conn;
  // console.log("a" + code.toString());
  try {
    conn = await db.getConnection(connCfg);
    result = await db.compile(conn, code.toString());
    errors = db.createErrorList();
    lines = await db.getDbmsOutput(conn);
  } catch (error) {
    // Oracle returns character offset of error
    const { line, position } = getLineAndPosition(code, error.offset);
    let msg = error.message;
    errors = db.getErrorSystem(msg, lineOffset, line, position);
  } finally {
    conn && conn.close();
  }
  // Return results, errors array, file and env params
  // dbmsoutput lines
  return {
    obj,
    file,
    env,
    errors,
    result,
    lines
  };
};

obj.runFileAsScript = (file, env) => {
  const obj = utils.getDBObjectFromPath(file);
  const owner = obj.owner;
  const connCfg = db.getConfiguration(env, owner);
  const connString = db.getConnectionString(connCfg);
  const cmd = `(echo connect ${connString} & echo start ${file} & echo show errors) | sqlplus -S /nolog`;
  return utils.execPromise(cmd);
};

obj.getObjectsInfoByType = async (env, owner, objectTypes) => {
  const connCfg = db.getConfiguration(env, owner);
  let conn;
  let result = [];
  try {
    conn = await db.getConnection(connCfg);
    for (let objectType of objectTypes) {
      const objects = await db.getObjectsInfo(conn, { owner, objectType });
      result = result.concat(objects);
    }
  } catch (error) {
    throw error;
  } finally {
    conn && conn.close();
  }
  return result;
};

obj.resolveObjectInfo = async (env, { name }) => {
  let connCfg = db.getConfiguration(env);
  let conn;
  let result;
  try {
    let schema, part1, part2;
    let objectName;
    conn = await db.getConnection(connCfg);
    // Try to resolve object name for every context [0..9] (obj type)
    for (let context = 0; context < 10; context++) {
      try {
        ({ schema, part1, part2 } = await db.getNameResolve(conn, {
          name,
          context
        }));
      } catch (error) {
        if (error.errorNum != "4047") {
          throw error;
        }
      }
      objectName = part1 || part2;
      if (objectName) break;
    }

    await conn.close();
    // Get connection to object schema
    connCfg = db.getConfiguration(env, schema);
    conn = await db.getConnection(connCfg);
    result = await db.getObjectsInfo(conn, {
      owner: schema,
      objectName
    });
  } catch (error) {
    throw error;
  } finally {
    conn && conn.close();
  }
  return result;
};

obj.getGenerator = async ({ func, file, env, object }) => {
  const obj = utils.getDBObjectFromPath(file);
  const connCfg = db.getConfiguration(env, obj.owner);
  obj.owner = connCfg.user.toUpperCase();

  let result = {};
  let conn;
  try {
    conn = await db.getConnection(connCfg);
    result = await db.getGeneratorFunction(conn, func, obj, object);
  } catch (error) {
    throw error;
  } finally {
    conn && conn.close();
  }
  return {
    obj,
    file,
    env,
    result
  };
};

module.exports = obj;
