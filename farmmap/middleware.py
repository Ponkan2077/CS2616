class NoCacheForAuthenticatedUsersMiddleware:
    """
    Prevents mobile browsers from serving a stale cached page (e.g. an old
    unauthenticated '/' response) once a user is logged in. Without this,
    a successful login can redirect to the dashboard URL but the browser
    shows a cached copy from before login instead of fetching it fresh,
    making it look like the redirect "failed" until the user manually
    reloads or re-enters the URL.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            response["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response["Pragma"] = "no-cache"
        return response
