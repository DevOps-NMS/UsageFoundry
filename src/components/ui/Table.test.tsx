import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TBody, THead, Table, Td, Th, Tr } from "./Table";

/**
 * `stack` is the second invariant in this app expressed purely in styling, and
 * it fails in both directions without throwing, logging or failing a typecheck.
 *
 * One way is on the phone. Below `md` the column heads are taken off the screen
 * and the grid becomes one block per record, so the *only* thing naming a value
 * is the `label` its own `Td` carries and the *only* thing carrying the row and
 * column relationships is the explicit ARIA role — `display: block` strips the
 * implicit one in every engine. Drop either and the desktop is pixel-identical
 * and the reading is a column of unnamed figures.
 *
 * The other way is on the desktop, and it is the promise the whole change was
 * made under: a table that did not ask for this must emit exactly what it
 * emitted before. Every mobile rule here is behind a breakpoint prefix, so
 * "no `md:` anywhere in a flat table" is the whole of that claim, checkable in
 * one assertion.
 */

const flat = (children: ReactNode) =>
  renderToStaticMarkup(<Table>{children}</Table>);

const stacked = (children: ReactNode) =>
  renderToStaticMarkup(<Table stack>{children}</Table>);

const ROW = (
  <>
    <THead>
      <tr>
        <Th>Repository</Th>
        <Th num>Cost</Th>
      </tr>
    </THead>
    <TBody>
      <Tr>
        <Td>usagefoundry</Td>
        <Td num label="Cost">
          $1.00
        </Td>
      </Tr>
    </TBody>
  </>
);

test("a table that did not ask to stack emits no breakpoint rule at all", () => {
  const html = flat(ROW);
  assert.doesNotMatch(
    html,
    /md:/,
    "every mobile rule is prefixed, so one appearing here is a desktop change",
  );
  assert.doesNotMatch(html, /role="/, "an implicit role is not restated");
  assert.doesNotMatch(
    html,
    /<span[^>]*>Cost<\/span>/,
    "a label reaches the markup only where the row can become a block",
  );
});

test("a stacked cell carries the name of its own field", () => {
  const html = stacked(ROW);
  assert.match(
    html,
    /<span class="[^"]*md:hidden[^"]*">Cost<\/span>/,
    "the field name is in the cell, and only below the breakpoint",
  );
});

test("a stacked table keeps the relationships display:block takes away", () => {
  const html = stacked(ROW);
  assert.match(html, /<table role="table"/);
  assert.match(html, /<thead role="rowgroup"/);
  assert.match(html, /<tbody role="rowgroup"/);
  assert.match(html, /<tr role="row"/);
  assert.match(html, /<td role="cell"/);
});

test("the column heads go, and the cells' own names are what replaces them", () => {
  const html = stacked(ROW);
  assert.match(html, /<thead role="rowgroup" class="max-md:hidden"/);
  // Both halves or neither: a head hidden with nothing put in its place is the
  // column of unnamed figures this whole prop exists to avoid.
  assert.match(html, />Cost<\/span>/);
});

test("the value is wrapped in a box that exists only below the breakpoint", () => {
  // Several cells hold two children — a figure and the guard's higher reading
  // beside it — which without a wrapper would be two flex items with the field
  // name pushed between them. `contents` is what keeps that wrapper out of the
  // flat table's layout; a plain `block` there would be a desktop change.
  const html = stacked(ROW);
  assert.match(html, /md:contents/);
});

test("a headline cell takes no name and stays a block", () => {
  const html = renderToStaticMarkup(
    <Table stack>
      <TBody>
        <Tr>
          <Td>usagefoundry</Td>
        </Tr>
      </TBody>
    </Table>,
  );
  assert.match(html, /max-md:block/);
  assert.doesNotMatch(
    html,
    /max-md:flex/,
    "nothing to put at the other edge of the row",
  );
  assert.doesNotMatch(html, /md:contents/, "and nothing to wrap");
});

/**
 * The workflow instance page draws two tables out of one `RunTableHead` and one
 * `RunRows`, which is the whole reason `stack` is a context rather than a prop:
 * a shared body that had to be *told* would be told at one call site and
 * forgotten at the other, and the table that was not told would render its
 * figures unnamed below the breakpoint with nothing on the desktop to show for
 * it. The control is half of this — the same body in a table that did not ask
 * has to come back flat, or the context is leaking rather than carrying.
 */
test("`stack` reaches a cell some other component rendered, and only there", () => {
  function Body() {
    return (
      <TBody>
        <Tr>
          <Td num label="Spent">
            $1.00
          </Td>
        </Tr>
      </TBody>
    );
  }

  const inStackTable = renderToStaticMarkup(
    <Table stack>
      <Body />
    </Table>,
  );
  assert.match(inStackTable, /<tbody role="rowgroup"/);
  assert.match(inStackTable, /<span class="[^"]*md:hidden[^"]*">Spent<\/span>/);

  const inFlatTable = renderToStaticMarkup(
    <Table>
      <Body />
    </Table>,
  );
  assert.doesNotMatch(inFlatTable, /md:/);
  assert.doesNotMatch(inFlatTable, /<span[^>]*>Spent<\/span>/);
});

test("a prose value takes the width instead of the right half of the row", () => {
  const html = renderToStaticMarkup(
    <Table stack>
      <TBody>
        <Tr>
          <Td label="Description" labelPlacement="above">
            What Claude reads when it decides whether to delegate
          </Td>
        </Tr>
      </TBody>
    </Table>,
  );
  assert.match(html, /<span class="[^"]*md:hidden[^"]*">Description<\/span>/);
  assert.doesNotMatch(
    html,
    /max-md:flex/,
    "above the value, so the cell is a block and not a two-column row",
  );
});
