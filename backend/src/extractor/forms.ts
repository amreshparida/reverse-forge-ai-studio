import { Page } from 'playwright';

export interface FormField {
  label: string;
  name: string;
  type: string;
  placeholder: string;
  required: boolean;
  options?: string[];
  id?: string;
}

export interface FormData {
  id?: string;
  action?: string;
  method?: string;
  title?: string;
  fields: FormField[];
}

export async function extractForms(page: Page): Promise<FormData[]> {
  return page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form, [role="form"]'));

    function getLabel(input: Element): string {
      // Check for associated label
      const id = input.getAttribute('id');
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent?.trim() ?? '';
      }
      // Check parent label
      const parentLabel = input.closest('label');
      if (parentLabel) {
        return (parentLabel.textContent?.trim() ?? '').replace(
          (input as HTMLInputElement).value ?? '',
          '',
        );
      }
      // Check aria-label
      const ariaLabel = input.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      // Check placeholder
      const placeholder = input.getAttribute('placeholder');
      if (placeholder) return placeholder;
      // Check previous sibling text
      const prevSibling = input.previousElementSibling;
      if (prevSibling) return prevSibling.textContent?.trim() ?? '';
      return '';
    }

    function extractFields(form: Element): FormField[] {
      const inputs = Array.from(
        form.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
      );
      return inputs.map((input) => {
        const el = input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const type = el.tagName === 'SELECT' ? 'select' : (el as HTMLInputElement).type || 'text';
        const options: string[] = [];

        if (el.tagName === 'SELECT') {
          const selectEl = el as HTMLSelectElement;
          Array.from(selectEl.options)
            .slice(0, 20)
            .forEach((opt) => {
              if (opt.value && opt.text) options.push(opt.text.trim());
            });
        }

        return {
          label: getLabel(el),
          name: el.getAttribute('name') || el.id || '',
          type,
          placeholder: el.getAttribute('placeholder') || '',
          required: el.hasAttribute('required'),
          options: options.length > 0 ? options : undefined,
          id: el.id || undefined,
        } as {
          label: string;
          name: string;
          type: string;
          placeholder: string;
          required: boolean;
          options?: string[];
          id?: string;
        };
      });
    }

    if (forms.length > 0) {
      return forms.map((form) => ({
        id: form.getAttribute('id') || undefined,
        action: (form as HTMLFormElement).action || undefined,
        method: (form as HTMLFormElement).method || undefined,
        title:
          form.querySelector('h1, h2, h3, legend, .form-title')?.textContent?.trim() || undefined,
        fields: extractFields(form),
      }));
    }

    // If no <form> elements, look for form-like containers
    const formLike = document.querySelector('[class*="form"], [class*="Form"]');
    if (formLike) {
      return [
        {
          id: undefined,
          action: undefined,
          method: undefined,
          title: formLike.querySelector('h1,h2,h3')?.textContent?.trim() || undefined,
          fields: extractFields(formLike),
        },
      ];
    }

    return [];
  });
}
