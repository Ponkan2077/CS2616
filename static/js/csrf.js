function getCsrfToken() {
  return document.querySelector('input[name=csrfmiddlewaretoken]').value;
}
