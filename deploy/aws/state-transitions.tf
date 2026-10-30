# Preserve adopted resource addresses when upgrading the reconciled module.
moved {
  from = aws_s3_bucket_lifecycle_configuration.esuno_buffer
  to   = aws_s3_bucket_lifecycle_configuration.buffer
}

moved {
  from = aws_iam_user_policy.esuno_smtp
  to   = aws_iam_user_policy.sending
}

# OpenTofu 1.9 removed blocks forget resources without destroying them.
# Nested lifecycle blocks are only supported by OpenTofu 1.10 and later.
removed {
  from = aws_ses_domain_identity.domain
}

removed {
  from = aws_ses_domain_dkim.domain
}

removed {
  from = aws_ses_domain_mail_from.domain
}

# SMTP credentials and their user are externally managed.
removed {
  from = aws_iam_user.sending
}
