const output = document.querySelector("#status");
try {
  const response = await fetch("/status");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (output)
    output.textContent = JSON.stringify(await response.json(), null, 2);
} catch {
  if (output) output.textContent = "Preview unavailable.";
}

export {};
