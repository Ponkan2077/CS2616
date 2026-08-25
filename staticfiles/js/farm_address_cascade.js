/* Wires up the Region -> Province -> City/Municipality -> Barangay
   cascade on the Add Farm modal (farm_list.html). Each select's value is
   a PSGC code (needed to fetch the next level); the human-readable name
   gets copied into a matching hidden input on every change, since that's
   what farm_create actually saves. */

function populateSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = placeholder;
  selectEl.appendChild(opt0);
  items.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item.code;
    opt.textContent = item.name;
    selectEl.appendChild(opt);
  });
}

function resetSelect(selectEl, placeholder) {
  populateSelect(selectEl, [], placeholder);
  selectEl.disabled = true;
}

function selectedText(selectEl) {
  return selectEl.selectedIndex >= 0 ? selectEl.options[selectEl.selectedIndex].textContent : "";
}

async function loadInto(selectEl, url, placeholder) {
  resetSelect(selectEl, "Loading…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("request failed");
    const data = await res.json();
    populateSelect(selectEl, data.results, placeholder);
    selectEl.disabled = false;
  } catch (e) {
    resetSelect(selectEl, "Couldn't load — try again");
  }
}

function wireAddressCascade() {
  const regionSelect = document.getElementById("region-select");
  const provinceSelect = document.getElementById("province-select");
  const citySelect = document.getElementById("city-select");
  const barangaySelect = document.getElementById("barangay-select");
  if (!regionSelect) return;

  const regionName = document.getElementById("region_name");
  const provinceName = document.getElementById("province_name");
  const cityName = document.getElementById("city_name");
  const barangayName = document.getElementById("barangay_name");

  regionSelect.addEventListener("change", () => {
    regionName.value = regionSelect.value ? selectedText(regionSelect) : "";
    resetSelect(provinceSelect, "Select Region first");
    resetSelect(citySelect, "Select Province first");
    resetSelect(barangaySelect, "Select City first");
    provinceName.value = ""; cityName.value = ""; barangayName.value = "";
    if (regionSelect.value) loadInto(provinceSelect, `/api/psgc/provinces/${regionSelect.value}/`, "Select Province");
  });

  provinceSelect.addEventListener("change", () => {
    provinceName.value = provinceSelect.value ? selectedText(provinceSelect) : "";
    resetSelect(citySelect, "Select Province first");
    resetSelect(barangaySelect, "Select City first");
    cityName.value = ""; barangayName.value = "";
    if (provinceSelect.value) loadInto(citySelect, `/api/psgc/cities/${provinceSelect.value}/`, "Select City / Municipality");
  });

  citySelect.addEventListener("change", () => {
    cityName.value = citySelect.value ? selectedText(citySelect) : "";
    resetSelect(barangaySelect, "Select City first");
    barangayName.value = "";
    if (citySelect.value) loadInto(barangaySelect, `/api/psgc/barangays/${citySelect.value}/`, "Select Barangay");
  });

  barangaySelect.addEventListener("change", () => {
    barangayName.value = barangaySelect.value ? selectedText(barangaySelect) : "";
  });
}

document.addEventListener("DOMContentLoaded", wireAddressCascade);
