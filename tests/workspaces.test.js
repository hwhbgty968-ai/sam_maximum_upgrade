const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const repo = process.argv[2] || path.join(__dirname, "..");
const { dir, t, done } = require("./_env")("workspaces");
const { db, init } = require(repo + "/lib/db.js");
const W = require(repo + "/lib/workspaces.js");
const accounts = require(repo + "/lib/accounts.js");
const imageStudio = require(repo + "/lib/image-studio.js");

(async () => {
  await init();
  const A = await db.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", "alice", "hash");
  const B = await db.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", "bob", "hash");
  const count = async (table, userId) => Number((await db.get("SELECT COUNT(*) AS c FROM " + table + " WHERE user_id=?", userId)).c);

  await t("projects are private to their owner", async () => {
    const p = await W.createProject(A, { name: "School project", description: "Biology revision" });
    assert.equal(p.name, "School project");
    assert.equal((await W.listProjects(A)).length, 1);
    assert.equal((await W.listProjects(B)).length, 0);
    assert.equal(await W.updateProject(B, p.id, { name: "Stolen" }), null);
    assert.equal(await W.deleteProject(B, p.id), false);
  });

  let project;
  await t("tasks create, update, complete and remain account-scoped", async () => {
    project = (await W.listProjects(A))[0];
    const task = await W.createTask(A, { title: "Revise DNA", projectId: project.id, priority: "high", dueAt: "2027-01-10T12:00:00.000Z" });
    assert.equal(task.title, "Revise DNA");
    assert.equal((await W.listTasks(A)).length, 1);
    assert.equal((await W.listTasks(B)).length, 0);
    assert.equal(await W.updateTask(B, task.id, { status: "done" }), null);
    const doneTask = await W.updateTask(A, task.id, { status: "done" });
    assert.equal(doneTask.status, "done");
    assert.equal(await W.deleteTask(B, task.id), false);
    assert.equal(await W.deleteTask(A, task.id), true);
    assert.equal((await W.listTasks(A)).length, 0);
  });

  await t("notes are private and can be updated", async () => {
    const note = await W.createNote(A, { title: "Revision notes", body: "DNA has a double helix.", projectId: project.id });
    assert.equal((await W.listNotes(A)).length, 1);
    assert.equal((await W.listNotes(B)).length, 0);
    assert.equal(await W.updateNote(B, note.id, { body: "changed" }), null);
    assert.equal((await W.updateNote(A, note.id, { body: "DNA stores genetic instructions." })).body, "DNA stores genetic instructions.");
    assert.equal(await W.deleteNote(B, note.id), false);
  });

  let app;
  await t("App Builder saves apps and versions privately", async () => {
    const html1 = "<!doctype html><html><head><title>Counter</title></head><body><button>Count</button></body></html>";
    app = await W.createApp(A, { title: "Counter", description: "A test app", html: html1, prompt: "Build a counter" });
    if (!app || !app.id) throw new Error("createApp did not return saved app: " + JSON.stringify(app));
    const aliceApps = await W.listApps(A);
    if (aliceApps.length !== 1) throw new Error("Alice should have one app; got " + JSON.stringify(aliceApps));
    const bobApps = await W.listApps(B);
    if (bobApps.length !== 0) throw new Error("Bob must not see Alice's apps: " + JSON.stringify(bobApps));
    if (await W.getApp(B, app.id) !== null) throw new Error("Bob must not fetch Alice's app.");
    const html2 = "<!doctype html><html><head><title>Timer</title></head><body><button>Start</button></body></html>";
    const updated = await W.updateApp(A, app.id, { html: html2, prompt: "Change it to a timer" });
    if (!updated || !/Timer/.test(updated.html)) throw new Error("App update failed: " + JSON.stringify(updated));
    const versions = await W.listAppVersions(A, app.id);
    if (!versions || versions.length !== 2) throw new Error("Expected 2 versions after create+update, got: " + JSON.stringify(versions));
    if (await W.listAppVersions(B, app.id) !== null) throw new Error("Bob must not list Alice's versions.");
    const restored = await W.restoreAppVersion(A, app.id, versions[1].id);
    if (!restored || !/Counter/.test(restored.html)) throw new Error("Restore did not restore original HTML; version rows were: " + JSON.stringify(versions) + "; app: " + JSON.stringify(restored));
    const afterRestore = await W.listAppVersions(A, app.id);
    if (!afterRestore || afterRestore.length !== 3) throw new Error("Expected third version after restore, got: " + JSON.stringify(afterRestore));
  });

  await t("deleting a project leaves its tasks and notes safely unassigned", async () => {
    await W.createTask(A, { title: "Independent task", projectId: project.id });
    await W.createNote(A, { title: "Independent note", body: "Keep this after deleting project.", projectId: project.id });
    assert.equal(await W.deleteProject(A, project.id), true);
    assert.equal((await W.listProjects(A)).length, 0);
    const tasks = await W.listTasks(A);
    const notes = await W.listNotes(A);
    assert.equal(tasks[0].project_id, null);
    assert.equal(notes[0].project_id, null);
  });

  await t("account export includes productivity data and app source", async () => {
    const data = await accounts.exportUserData(A);
    assert.equal(data.projects.length, 0);
    assert.equal(data.tasks.length, 1);
    assert.equal(data.notes.length, 2);
    assert.equal(data.apps.length, 1);
    assert.match(data.apps[0].html, /Counter/);
  });

  await t("account deletion removes workspace records and local generated image files", async () => {
    const dirPath = imageStudio.storageDir();
    fs.mkdirSync(dirPath, { recursive: true });
    const fileName = "test-image.png";
    fs.writeFileSync(path.join(dirPath, fileName), Buffer.from("test-image"));
    await db.insert("INSERT INTO media_assets(user_id,filename,prompt,size,mime_type) VALUES(?,?,?,?,?)", A, fileName, "Test image", "1024x1024", "image/png");
    await accounts.deleteUserData(A);
    for (const table of ["workspace_projects","workspace_tasks","workspace_notes","workspace_apps","workspace_app_versions","media_assets","plugin_connections","plugin_activity"]) {
      assert.equal(await count(table, A), 0, table);
    }
    assert.equal(fs.existsSync(path.join(dirPath, fileName)), false);
    assert.equal(await count("workspace_apps", B), 0, "other user remains separate");
  });

  await db.close();
  done("workspaces.js");
})();
