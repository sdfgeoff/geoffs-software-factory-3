import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRepositoryUrl } from "../server/git.mjs";
test("repository URLs accept pasted SSH clone addresses without changing SSH path semantics", () => {
  for (const url of [
    "git@github.com:sdfgeoff/geoffs-software-factory-3.git",
    "git@gitlab.example.com:group/subgroup/repo.git",
    "git@bitbucket.org:team/repo.git",
    "work-git:team/repo.git",
    "git@host:~/team/repo.git",
    "git@host:/srv/git/repo.git",
    "git@[::1]:team/repo.git",
    "ssh://git@host:2222/team/repo.git",
    "https://host/team/repo.git",
    "/srv/local repositories/repo.git",
  ])
    assert.equal(validateRepositoryUrl(url), url);
});
test("repository URL validation rejects helper transports, credentials and malformed pasted URLs", () => {
  for (const url of [
    "git@host:-option",
    "-option@host:repo",
    "ext::sh",
    "ssh::run",
    "ssh:///missing-host",
    "file:///tmp/repo",
    "http://host/repo",
    "https://user:password@host/repo",
    "ssh://user:password@host/repo",
    "git@host:repo?query",
    "git@host:repo#fragment",
    "git@host:repo\nother",
    "ssh://git@github.com:team/repo.git",
  ])
    assert.throws(
      () => validateRepositoryUrl(url),
      (e) => e.status === 400,
      url,
    );
});
