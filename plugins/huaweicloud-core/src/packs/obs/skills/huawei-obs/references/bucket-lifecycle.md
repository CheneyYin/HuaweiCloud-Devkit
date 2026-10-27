# OBS Bucket Lifecycle

> KooCLI OBS uses obsutil-style commands. `OBS CreateBucket` → `OBS mb`. `SetBucketWebsite` (API-style) is not a KooCLI operation: 7.3.12+ ships `hcloud OBS website obs://<bucket> -method=put -localfile=<xml>`; the plugin's `huaweicloud_obs_set_website_config` tool (set/get/delete) needs no XML file. 7.2.x had neither.

## Create Bucket

hcloud OBS mb obs://<bucket> -location=<region>

## Lifecycle Rules (JSON)

{
"Rules": [{
"ID": "move-to-ia-after-30d",
"Status": "Enabled",
"Filter": {"Prefix": ""},
"Transitions": [{"Days": 30, "StorageClass": "STANDARD_IA"}],
"Expiration": {"Days": 365}
}]
}

## Apply

hcloud OBS lifecycle obs://<bucket> -method=put -localfile=<lifecycle.json>

## Static Website

On KooCLI 7.3.12+: `hcloud OBS website obs://<bucket> -method=put -localfile=<xml>`. On older versions: `huaweicloud_obs_set_website_config` (the plugin tool) or the console. Use `hcloud OBS chattri obs://<bucket> -acl=public-read` for bucket ACL either way.

## Cross-Region Replication

Requires: source bucket versioning enabled, destination bucket in different region, replication IAM role.
