import Indentation from './Indentation';
import InlineBlock from './InlineBlock';
import Params from './Params';
import { trimSpacesEnd } from '../utils';
import { isReserved, isCommand, isToken, Token, TokenType, EOF_TOKEN } from './token';
import { FormatOptions } from '../types';
import { toTabularToken, replaceTabularPlaceholders } from './tabularStyle';
import AliasAs from './AliasAs';
import AsTokenFactory from './AsTokenFactory';
import { Statement } from './Parser';
import { indentString, isTabularStyle } from './config';

/** Formats single SQL statement */
export default class StatementFormatter {
  private cfg: FormatOptions;
  private indentation: Indentation;
  private inlineBlock: InlineBlock;
  private aliasAs: AliasAs;
  private params: Params;
  private asTokenFactory: AsTokenFactory;

  private currentNewline = true;
  private previousReservedToken: Token = EOF_TOKEN;
  private previousCommandToken: Token = EOF_TOKEN;
  private tokens: Token[] = [];
  private index = -1;

  constructor(cfg: FormatOptions, params: Params, asTokenFactory: AsTokenFactory) {
    this.cfg = cfg;
    this.indentation = new Indentation(indentString(cfg));
    this.inlineBlock = new InlineBlock(this.cfg.expressionWidth);
    this.aliasAs = new AliasAs(this.cfg.aliasAs, this);
    this.params = params;
    this.asTokenFactory = asTokenFactory;
  }

  public format(statement: Statement): string {
    this.tokens = statement.tokens;
    let formattedQuery = '';

    for (this.index = 0; this.index < this.tokens.length; this.index++) {
      let token = this.tokens[this.index];

      // if token is a Reserved Keyword, Command, Binary Command, Dependent Clause, Logical Operator, CASE, END
      if (isReserved(token)) {
        this.previousReservedToken = token;
        if (
          token.type === TokenType.RESERVED_LOGICAL_OPERATOR ||
          token.type === TokenType.RESERVED_DEPENDENT_CLAUSE ||
          token.type === TokenType.RESERVED_COMMAND ||
          token.type === TokenType.RESERVED_BINARY_COMMAND
        ) {
          token = toTabularToken(token, this.cfg.indentStyle);
        }
        if (token.type === TokenType.RESERVED_COMMAND) {
          this.previousCommandToken = token;
        }
      }

      if (token.type === TokenType.LINE_COMMENT) {
        formattedQuery = this.formatLineComment(token, formattedQuery);
      } else if (token.type === TokenType.BLOCK_COMMENT) {
        formattedQuery = this.formatBlockComment(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_COMMAND) {
        this.currentNewline = this.checkNewline(token);
        formattedQuery = this.formatCommand(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_BINARY_COMMAND) {
        formattedQuery = this.formatBinaryCommand(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_DEPENDENT_CLAUSE) {
        formattedQuery = this.formatDependentClause(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_JOIN_CONDITION) {
        formattedQuery = this.formatJoinCondition(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_LOGICAL_OPERATOR) {
        formattedQuery = this.formatLogicalOperator(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_KEYWORD) {
        formattedQuery = this.formatKeyword(token, formattedQuery);
      } else if (token.type === TokenType.BLOCK_START) {
        formattedQuery = this.formatBlockStart(token, formattedQuery);
      } else if (token.type === TokenType.BLOCK_END) {
        formattedQuery = this.formatBlockEnd(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_CASE_START) {
        formattedQuery = this.formatCaseStart(token, formattedQuery);
      } else if (token.type === TokenType.RESERVED_CASE_END) {
        formattedQuery = this.formatCaseEnd(token, formattedQuery);
      } else if (token.type === TokenType.PLACEHOLDER) {
        formattedQuery = this.formatPlaceholder(token, formattedQuery);
      } else if (token.type === TokenType.OPERATOR) {
        formattedQuery = this.formatOperator(token, formattedQuery);
      } else {
        formattedQuery = this.formatWord(token, formattedQuery);
      }
    }
    return replaceTabularPlaceholders(formattedQuery);
  }

  /**
   * Formats word tokens + any potential AS tokens for aliases
   */
  private formatWord(token: Token, query: string): string {
    let finalQuery = query;
    if (this.aliasAs.shouldAddBefore(token)) {
      finalQuery = this.formatWithSpaces(this.asTokenFactory.token(), finalQuery);
    }

    finalQuery = this.formatWithSpaces(token, finalQuery);

    if (this.aliasAs.shouldAddAfter()) {
      finalQuery = this.formatWithSpaces(this.asTokenFactory.token(), finalQuery);
    }

    return finalQuery;
  }

  /**
   * Checks if a newline should currently be inserted
   */
  private checkNewline(token: Token): boolean {
    const nextTokens = this.tokensUntilNextCommandOrQueryEnd();

    // auto break if SELECT includes CASE statements
    if (this.isWithinSelect() && nextTokens.some(isToken.CASE)) {
      return true;
    }

    switch (this.cfg.multilineLists) {
      case 'always':
        return true;
      case 'avoid':
        return false;
      case 'expressionWidth':
        return this.inlineWidth(token, nextTokens) > this.cfg.expressionWidth;
      default: // multilineLists mode is a number
        return (
          this.countClauses(nextTokens) > this.cfg.multilineLists ||
          this.inlineWidth(token, nextTokens) > this.cfg.expressionWidth
        );
    }
  }

  private inlineWidth(token: Token, tokens: Token[]): number {
    const tokensString = tokens.map(({ value }) => (value === ',' ? value + ' ' : value)).join('');
    return `${token.whitespaceBefore}${token.value} ${tokensString}`.length;
  }

  /**
   * Counts comma-separated clauses (doesn't count commas inside blocks)
   * Note: There's always at least one clause.
   */
  private countClauses(tokens: Token[]): number {
    let count = 1;
    let openBlocks = 0;
    for (const { type, value } of tokens) {
      if (value === ',' && openBlocks === 0) {
        count++;
      }
      if (type === TokenType.BLOCK_START) {
        openBlocks++;
      }
      if (type === TokenType.BLOCK_END) {
        openBlocks--;
      }
    }
    return count;
  }

  /** get all tokens between current token and next Reserved Command or query end */
  private tokensUntilNextCommandOrQueryEnd(): Token[] {
    const tail = this.tokens.slice(this.index + 1);
    return tail.slice(
      0,
      tail.length ? tail.findIndex(token => isCommand(token) || token.value === ';') : undefined
    );
  }

  /** Formats a line comment onto query */
  private formatLineComment(token: Token, query: string): string {
    return this.addNewline(query + this.show(token));
  }

  /** Formats a block comment onto query */
  private formatBlockComment(token: Token, query: string): string {
    return this.addNewline(this.addNewline(query) + this.indentComment(token.value));
  }

  /** Aligns comment to current indentation level */
  private indentComment(comment: string): string {
    return comment.replace(/\n[ \t]*/gu, '\n' + this.indentation.getIndent() + ' ');
  }

  /**
   * Formats a Reserved Command onto query, increasing indentation level where necessary
   */
  private formatCommand(token: Token, query: string): string {
    this.indentation.decreaseTopLevel();

    query = this.addNewline(query);

    // indent tabular formats, except when preceding a (
    if (isTabularStyle(this.cfg)) {
      if (this.tokenLookAhead().value !== '(') {
        this.indentation.increaseTopLevel();
      }
    } else {
      this.indentation.increaseTopLevel();
    }

    query += this.equalizeWhitespace(this.show(token)); // print token onto query
    if (this.currentNewline && !isTabularStyle(this.cfg)) {
      query = this.addNewline(query);
    } else {
      query += ' ';
    }
    return query;
  }

  /**
   * Formats a Reserved Binary Command onto query, joining neighbouring tokens
   */
  private formatBinaryCommand(token: Token, query: string): string {
    const isJoin = /JOIN/i.test(token.value); // check if token contains JOIN
    if (!isJoin || isTabularStyle(this.cfg)) {
      // decrease for boolean set operators or in tabular mode
      this.indentation.decreaseTopLevel();
    }
    query = this.addNewline(query) + this.equalizeWhitespace(this.show(token));
    return isJoin ? query + ' ' : this.addNewline(query);
  }

  /**
   * Formats a Reserved Keyword onto query, skipping AS if disabled
   */
  private formatKeyword(token: Token, query: string): string {
    if (isToken.AS(token) && this.aliasAs.shouldRemove()) {
      return query;
    }

    return this.formatWithSpaces(token, query);
  }

  /**
   * Formats a Reserved Dependent Clause token onto query, supporting the keyword that precedes it
   */
  private formatDependentClause(token: Token, query: string): string {
    return this.addNewline(query) + this.equalizeWhitespace(this.show(token)) + ' ';
  }

  // Formats ON and USING keywords
  private formatJoinCondition(token: Token, query: string): string {
    return query + this.equalizeWhitespace(this.show(token)) + ' ';
  }

  /**
   * Formats an Operator onto query, following rules for specific characters
   */
  private formatOperator(token: Token, query: string): string {
    // special operator
    if (token.value === ',') {
      return this.formatComma(token, query);
    } else if (token.value === ';') {
      return this.formatQuerySeparator(token, query);
    } else if (['$', '['].includes(token.value)) {
      return this.formatWithSpaceBefore(token, query);
    } else if ([':', ']'].includes(token.value)) {
      return this.formatWithSpaceAfter(token, query);
    } else if (['.', '{', '}', '`'].includes(token.value)) {
      return this.formatWithoutSpaces(token, query);
    }

    // regular operator
    if (this.cfg.denseOperators && this.tokenLookBehind().type !== TokenType.RESERVED_COMMAND) {
      // do not trim whitespace if SELECT *
      return this.formatWithoutSpaces(token, query);
    }
    return this.formatWithSpaces(token, query);
  }

  /**
   * Formats a Logical Operator onto query, joining boolean conditions
   */
  private formatLogicalOperator(token: Token, query: string): string {
    // ignore AND when BETWEEN x [AND] y
    if (isToken.AND(token) && isToken.BETWEEN(this.tokenLookBehind(2))) {
      return this.formatWithSpaces(token, query);
    }

    if (isTabularStyle(this.cfg)) {
      this.indentation.decreaseTopLevel();
    }

    if (this.cfg.logicalOperatorNewline === 'before') {
      return (
        (this.currentNewline ? this.addNewline(query) : query) +
        this.equalizeWhitespace(this.show(token)) +
        ' '
      );
    } else {
      query += this.show(token);
      return this.currentNewline ? this.addNewline(query) : query;
    }
  }

  /** Replace any sequence of whitespace characters with single space */
  private equalizeWhitespace(string: string): string {
    return string.replace(/\s+/gu, ' ');
  }

  private formatBlockStart(token: Token, query: string): string {
    // Take out the preceding space unless there was whitespace there in the original query
    // or another opening parens or line comment
    const preserveWhitespaceFor = [
      TokenType.BLOCK_START,
      TokenType.LINE_COMMENT,
      TokenType.OPERATOR,
    ];
    if (
      token.whitespaceBefore?.length === 0 &&
      !preserveWhitespaceFor.includes(this.tokenLookBehind().type)
    ) {
      query = trimSpacesEnd(query);
    } else if (!this.cfg.newlineBeforeOpenParen) {
      query = query.trimEnd() + ' ';
    }
    query += this.show(token);
    this.inlineBlock.beginIfPossible(this.tokens, this.index);

    if (!this.inlineBlock.isActive()) {
      this.indentation.increaseBlockLevel();
      query = this.addNewline(query);
    }
    return query;
  }

  private formatBlockEnd(token: Token, query: string): string {
    if (this.inlineBlock.isActive()) {
      this.inlineBlock.end();
      return this.formatWithSpaceAfter(token, query); // do not add space before )
    } else {
      return this.formatMultilineBlockEnd(token, query);
    }
  }

  private formatCaseStart(token: Token, query: string): string {
    query = this.formatWithSpaces(token, query);
    this.indentation.increaseBlockLevel();
    if (this.cfg.multilineLists === 'always') {
      query = this.addNewline(query);
    }
    return query;
  }

  private formatCaseEnd(token: Token, query: string): string {
    return this.formatMultilineBlockEnd(token, query);
  }

  private formatMultilineBlockEnd(token: Token, query: string): string {
    this.indentation.decreaseBlockLevel();

    if (isTabularStyle(this.cfg)) {
      // +1 extra indentation step for the closing paren
      query = this.addNewline(query) + this.indentation.getSingleIndent();
    } else if (this.cfg.newlineBeforeCloseParen) {
      query = this.addNewline(query);
    } else {
      query = query.trimEnd() + ' ';
    }

    return this.formatWithSpaces(token, query);
  }

  /**
   * Formats a Placeholder item onto query, to be replaced with the value of the placeholder
   */
  formatPlaceholder(token: Token, query: string): string {
    return query + this.params.get(token) + ' ';
  }

  /**
   * Formats a comma Operator onto query, ending line unless in an Inline Block
   */
  private formatComma(token: Token, query: string): string {
    query = trimSpacesEnd(query) + this.show(token) + ' ';

    if (this.inlineBlock.isActive()) {
      return query;
    } else if (isToken.LIMIT(this.getPreviousReservedToken())) {
      return query;
    } else if (this.currentNewline) {
      return this.addNewline(query);
    } else {
      return query;
    }
  }

  /** Simple append of token onto query */
  private formatWithoutSpaces(token: Token, query: string): string {
    return trimSpacesEnd(query) + this.show(token);
  }

  private formatWithSpaces(token: Token, query: string): string {
    return query + this.show(token) + ' ';
  }

  private formatWithSpaceBefore(token: Token, query: string) {
    return query + this.show(token);
  }

  private formatWithSpaceAfter(token: Token, query: string) {
    return trimSpacesEnd(query) + this.show(token) + ' ';
  }

  private formatQuerySeparator(token: Token, query: string): string {
    return [
      trimSpacesEnd(query),
      this.cfg.newlineBeforeSemicolon ? '\n' : '',
      this.show(token),
    ].join('');
  }

  /** Converts token to string, uppercasing if enabled */
  private show(token: Token): string {
    if (isReserved(token)) {
      switch (this.cfg.keywordCase) {
        case 'preserve':
          return token.value;
        case 'upper':
          return token.value.toUpperCase();
        case 'lower':
          return token.value.toLowerCase();
      }
    } else {
      return token.value;
    }
  }

  /** Inserts a newline onto the query */
  private addNewline(query: string): string {
    query = trimSpacesEnd(query);
    if (!query.endsWith('\n') && query !== '') {
      query += '\n';
    }
    return query + this.indentation.getIndent();
  }

  /** Returns the latest encountered reserved keyword token */
  public getPreviousReservedToken(): Token {
    return this.previousReservedToken;
  }

  /** True when currently within SELECT command */
  public isWithinSelect(): boolean {
    return isToken.SELECT(this.previousCommandToken);
  }

  /** Fetches nth previous token from the token stream */
  public tokenLookBehind(n = 1): Token {
    return this.tokens[this.index - n] || EOF_TOKEN;
  }

  /** Fetches nth next token from the token stream */
  public tokenLookAhead(n = 1): Token {
    return this.tokens[this.index + n] || EOF_TOKEN;
  }
}
