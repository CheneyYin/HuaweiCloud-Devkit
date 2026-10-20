# IAM Policies — Least Privilege for huawei-cloud-dew-key-management

This skill requires IAM permissions on CSMS (service prefix `csms`), KMS (service prefix `kms`)
and CTS (service prefix `cts`). Grant the **minimum** permissions per capability group. Action names use the documented dotted-lowercase
IAM items (授权项), e.g. `csms:secret:list`, `kms:cmk:list`.
All policies are region-scoped (KMS/CSMS/CTS are regional services).

## 1. Query + Diagnose (R3, read-only)

Covers: `huawei_list_csms_secrets`, `huawei_describe_csms_secret`,
`huawei_list_csms_secret_versions`, `huawei_list_kms_keys`, `huawei_analyze_dew_rotation`,
`huawei_analyze_dew_key_usage`.

```json
{
  "Version": "1.0",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "csms:secret:list",
        "csms:secretVersion:list",
        "kms:cmk:list",
        "kms:cmk:get",
        "kms:cmk:getRotationStatus",
        "cts:trace:list"
      ],
      "Resource": ["*"]
    }
  ]
}
```

> `cts:trace:list` is only required for `huawei_analyze_dew_key_usage`.
> `kms:cmk:getRotationStatus` is only required for rotation analysis on the KMS key side.

## 2. Manage (R2 — create key, enable rotation)

Covers: `huawei_create_kms_key`, `huawei_enable_csms_secret_rotation`.

```json
{
  "Version": "1.0",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["kms:cmk:create", "kms:cmk:list", "kms:cmk:get", "csms:secret:update", "csms:secret:list"],
      "Resource": ["*"]
    }
  ]
}
```

## 3. Manage (R1 — rotate version, delete key)

Covers: `huawei_update_csms_secret_version`, `huawei_delete_kms_key`.

```json
{
  "Version": "1.0",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "csms:secret:rotate",
        "csms:secretVersion:create",
        "kms:cmk:scheduleDelete",
        "kms:cmk:cancelDeletion",
        "kms:cmk:list",
        "kms:cmk:get"
      ],
      "Resource": ["*"]
    }
  ]
}
```

## 4. Security notes

- **Never grant** secret-value read permissions to the agent principal:
  `csms:secretVersion:show` (read of the version payload), `csms:secret:download`,
  `kms:cmk:decryptData`, `kms:cmk:decryptDatakey`. The whole-chain policy blocks secret
  values from entering agent context. (Action names are the documented dotted-lowercase
  IAM items — e.g. `csms:secret:list`, `kms:cmk:list`; verify the current list at the
  reference URLs below before granting.)
- For stronger isolation, restrict `Resource` to specific secret names / key ids, e.g.
  `"Resource": ["*"]` → `"Resource": ["csms:*:secret:prod-*"]` where the service supports
  resource-level authorization (IAM resource tags / secret-level policy).
- Prefer custom roles scoped to the **project** that owns the secrets/keys; never use
  `Tenant Administrator` or `KMS Administrator` for agent execution.
- `kms:cmk:scheduleDelete` is destructive (irreversible after the pending window):
  consider granting it only in a restricted role used with explicit human confirmation.

## 5. Reference

- CSMS permissions: https://support.huaweicloud.com/usermanual-dew/dew_01_0019.html
- KMS permissions: https://support.huaweicloud.com/usermanual-dew/dew_01_0020.html
- CTS permissions: https://support.huaweicloud.com/usermanual-cts/cts_01_0037.html
