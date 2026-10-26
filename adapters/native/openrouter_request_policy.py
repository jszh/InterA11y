class ProviderOutputLimitError(RuntimeError):
    pass


def provider_policy(model, existing=None):
    return dict(existing or {})
