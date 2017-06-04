// @flow

import { types as tt, type TokenType } from "../tokenizer/types";
import type { Decorator, Expression, Identifier, Node, ObjectExpression, ObjectPattern, Pattern, RestElement,
  SpreadElement } from "../types";
import type { Pos, Position } from "../util/location";
import { NodeUtils } from "./node";

export default class LValParser extends NodeUtils {
  // Forward-declaration: defined in expression.js
  +checkReservedWord: (word: string, startLoc: number, checkKeywords: boolean, isBinding: boolean) => void;
  +parseIdentifier: (liberal?: boolean) => Identifier;
  +parseMaybeAssign: (
    noIn?: ?boolean,
    refShorthandDefaultPos?: ?Pos,
    afterLeftParse?: Function,
    refNeedsArrowPos?: ?Pos) => Expression;
  +parseObj: <T : ObjectPattern | ObjectExpression>(isPattern: boolean, refShorthandDefaultPos?: ?Pos) => T;
  // Forward-declaration: defined in statement.js
  +parseDecorator: () => Decorator;

  // Convert existing expression atom to assignable pattern
  // if possible.

  toAssignable(node: Node, isBinding: ?boolean, contextDescription: string): Node {
    if (node) {
      switch (node.type) {
        case "Identifier":
        case "PrivateName":
        case "ObjectPattern":
        case "ArrayPattern":
        case "AssignmentPattern":
          break;

        case "ObjectExpression":
          node.type = "ObjectPattern";
          for (const prop of node.properties) {
            if (prop.type === "ObjectMethod") {
              if (prop.kind === "get" || prop.kind === "set") {
                this.raise(prop.key.start, "Object pattern can't contain getter or setter");
              } else {
                this.raise(prop.key.start, "Object pattern can't contain methods");
              }
            } else {
              this.toAssignable(prop, isBinding, "object destructuring pattern");
            }
          }
          break;

        case "ObjectProperty":
          this.toAssignable(node.value, isBinding, contextDescription);
          break;

        case "SpreadElement":
          node.type = "RestElement";
          const arg = node.argument;
          this.toAssignable(arg, isBinding, contextDescription);
          break;

        case "ArrayExpression":
          node.type = "ArrayPattern";
          this.toAssignableList(node.elements, isBinding, contextDescription);
          break;

        case "AssignmentExpression":
          if (node.operator === "=") {
            node.type = "AssignmentPattern";
            delete node.operator;
          } else {
            this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
          }
          break;

        case "MemberExpression":
          if (!isBinding) break;

        default: {
          const message = "Invalid left-hand side" +
            (contextDescription ? " in " + contextDescription : /* istanbul ignore next */ "expression");
          this.raise(node.start, message);
        }
      }
    }
    return node;
  }

  // Convert list of expression atoms to binding list.

  toAssignableList(
    exprList: Expression[], isBinding: ?boolean, contextDescription: string): $ReadOnlyArray<Pattern> {
    let end = exprList.length;
    if (end) {
      const last = exprList[end - 1];
      if (last && last.type === "RestElement") {
        --end;
      } else if (last && last.type === "SpreadElement") {
        last.type = "RestElement";
        const arg = last.argument;
        this.toAssignable(arg, isBinding, contextDescription);
        if (
          arg.type !== "Identifier" &&
          arg.type !== "MemberExpression" &&
          arg.type !== "ArrayPattern"
        ) {
          this.unexpected(arg.start);
        }
        --end;
      }
    }
    for (let i = 0; i < end; i++) {
      const elt = exprList[i];
      if (elt && elt.type === "SpreadElement")
        this.raise(elt.start, "The rest element has to be the last element when destructuring");
      if (elt) this.toAssignable(elt, isBinding, contextDescription);
    }
    return exprList;
  }

  // Convert list of expression atoms to a list of

  toReferencedList(exprList: $ReadOnlyArray<?Expression>): $ReadOnlyArray<?Expression> {
    return exprList;
  }

  // Parses spread element.

  parseSpread<T : RestElement | SpreadElement>(refShorthandDefaultPos: ?Pos): T {
    const node = this.startNode();
    this.next();
    node.argument = this.parseMaybeAssign(false, refShorthandDefaultPos);
    return this.finishNode(node, "SpreadElement");
  }

  parseRest(): RestElement {
    const node = this.startNode();
    this.next();
    node.argument = this.parseBindingAtom();
    return this.finishNode(node, "RestElement");
  }

  shouldAllowYieldIdentifier(): boolean {
    return this.match(tt._yield) && !this.state.strict && !this.state.inGenerator;
  }

  parseBindingIdentifier(): Identifier {
    return this.parseIdentifier(this.shouldAllowYieldIdentifier());
  }

  // Parses lvalue (assignable) atom.
  parseBindingAtom(): Pattern {
    switch (this.state.type) {
      case tt._yield:
      case tt.name:
        return this.parseBindingIdentifier();

      case tt.bracketL:
        const node = this.startNode();
        this.next();
        node.elements = this.parseBindingList(tt.bracketR, true);
        return this.finishNode(node, "ArrayPattern");

      case tt.braceL:
        return this.parseObj(true);

      default:
        throw this.unexpected();
    }
  }

  parseBindingList(close: TokenType, allowEmpty?: boolean): $ReadOnlyArray<Pattern> {
    const elts = [];
    let first = true;
    while (!this.eat(close)) {
      if (first) {
        first = false;
      } else {
        this.expectLenient(tt.comma);
      }
      if (allowEmpty && this.match(tt.comma)) {
        // $FlowFixMe This method returns `$ReadOnlyArray<?Pattern>` if `allowEmpty` is set.
        elts.push(null);
      } else if (this.eat(close)) {
        break;
      } else if (this.match(tt.ellipsis)) {
        elts.push(this.parseAssignableListItemTypes(this.parseRest()));
        this.expect(close);
        break;
      } else {
        const decorators = [];
        while (this.match(tt.at)) {
          decorators.push(this.parseDecorator());
        }
        const left = this.parseMaybeDefault();
        if (decorators.length) {
          left.decorators = decorators;
        }
        this.parseAssignableListItemTypes(left);
        elts.push(this.parseMaybeDefault(left.start, left.loc.start, left));
      }
    }
    return elts;
  }

  parseAssignableListItemTypes(param: Pattern): Pattern {
    return param;
  }

  // Parses assignment pattern around given atom if possible.

  parseMaybeDefault(startPos?: ?number, startLoc?: ?Position, left?: ?Pattern): Pattern {
    startLoc = startLoc || this.state.startLoc;
    startPos = startPos || this.state.start;
    left = left || this.parseBindingAtom();
    if (!this.eat(tt.eq)) return left;

    const node = this.startNodeAt(startPos, startLoc);
    node.left = left;
    node.right = this.parseMaybeAssign();
    return this.finishNode(node, "AssignmentPattern");
  }

  // Verify that a node is an lval — something that can be assigned
  // to.

  checkLVal(
    expr: Expression,
    isBinding: ?boolean,
    checkClashes: ?{ [key: string]: boolean },
    contextDescription: string): void {
    switch (expr.type) {
      case "PrivateName":
      case "Identifier":
        this.checkReservedWord(expr.name, expr.start, false, true);

        if (checkClashes) {
          // we need to prefix this with an underscore for the cases where we have a key of
          // `__proto__`. there's a bug in old V8 where the following wouldn't work:
          //
          //   > var obj = Object.create(null);
          //   undefined
          //   > obj.__proto__
          //   null
          //   > obj.__proto__ = true;
          //   true
          //   > obj.__proto__
          //   null
          const key = `_${expr.name}`;

          if (checkClashes[key]) {
            this.raise(expr.start, "Argument name clash in strict mode");
          } else {
            checkClashes[key] = true;
          }
        }
        break;

      case "MemberExpression":
        if (isBinding)
          this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " member expression");
        break;

      case "ObjectPattern":
        for (let prop of expr.properties) {
          if (prop.type === "ObjectProperty") prop = prop.value;
          this.checkLVal(prop, isBinding, checkClashes, "object destructuring pattern");
        }
        break;

      case "ArrayPattern":
        for (const elem of expr.elements) {
          if (elem) this.checkLVal(elem, isBinding, checkClashes, "array destructuring pattern");
        }
        break;

      case "AssignmentPattern":
        this.checkLVal(expr.left, isBinding, checkClashes, "assignment pattern");
        break;

      case "RestElement":
        this.checkLVal(expr.argument, isBinding, checkClashes, "rest element");
        break;

      default: {
        const message = (isBinding ? /* istanbul ignore next */ "Binding invalid" : "Invalid") +
          " left-hand side" +
          (contextDescription ? " in " + contextDescription : /* istanbul ignore next */ "expression");
        this.raise(expr.start, message);
      }
    }
  }
}
