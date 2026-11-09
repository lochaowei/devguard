/**
 * The Checkstyle config devguard generates is Checkstyle 10.21's `google_checks.xml` (#131), minus the formatting modules
 * palantir-java-format (`spotless:apply`) also decides, plus the modules devguard adds from the declared standard.
 *
 * Source: https://github.com/checkstyle/checkstyle/blob/checkstyle-10.21.0/src/main/resources/google_checks.xml
 * Checkstyle is licensed under LGPL-2.1 (https://github.com/checkstyle/checkstyle/blob/master/LICENSE); this is a
 * modified copy. 10.21 is the lower bound of `tools.checkstyle` (`>=10.21,<15`): a newer google_checks.xml may use
 * modules 10.21 does not know, and Checkstyle refuses a config with an unknown module, so every version in range
 * must be able to load this one.
 *
 * Removed because palantir-java-format lays the same thing out differently or checks the same whitespace, so the two
 * could disagree on a formatted file: LineLength, Indentation, OperatorWrap, SeparatorWrap (all five), WhitespaceAround,
 * WhitespaceAfter, GenericWhitespace, MethodParamPad, NoWhitespaceBefore, NoWhitespaceBeforeCaseDefaultColon,
 * ParenPad, LeftCurly, RightCurly, NoLineWrap, EmptyLineSeparator, RegexpSinglelineJava (the `{ }` check),
 * CommentsIndentation, AnnotationLocation and CustomImportOrder (palantir sorts imports), together with the
 * SuppressionXpathSingleFilter entries that only existed for them. Naming, import, Javadoc and other non-layout
 * modules are kept as shipped.
 */

/** Where the devguard modules go in the TreeWalker. */
export const DEVGUARD_MODULES_MARK = "__DEVGUARD__";

/** Checkstyle version the bundled google_checks.xml comes from. */
export const GOOGLE_CHECKS_VERSION = "10.21.0";

/** The google_checks.xml source URL, for the generated file's header. */
export const GOOGLE_CHECKS_URL =
  "https://github.com/checkstyle/checkstyle/blob/checkstyle-10.21.0/src/main/resources/google_checks.xml";

/** The Checker body (properties, filters, TreeWalker), with `${` written as `%{`. */
const BODY = String.raw`
  <property name="charset" value="UTF-8"/>
  <property name="severity" value="%{org.checkstyle.google.severity}" default="warning"/>
  <property name="fileExtensions" value="java, properties, xml"/>
  <!-- Excludes all 'module-info.java' files              -->
  <!-- See https://checkstyle.org/filefilters/index.html -->
  <module name="BeforeExecutionExclusionFileFilter">
    <property name="fileNamePattern" value="module\-info\.java$"/>
  </module>
  <module name="SuppressWarningsFilter"/>
  <!-- https://checkstyle.org/filters/suppressionfilter.html -->
  <module name="SuppressionFilter">
    <property name="file" value="%{org.checkstyle.google.suppressionfilter.config}"
           default="checkstyle-suppressions.xml" />
    <property name="optional" value="true"/>
  </module>
  <!-- https://checkstyle.org/filters/suppresswithnearbytextfilter.html -->
  <module name="SuppressWithNearbyTextFilter">
    <property name="nearbyTextPattern"
              value="CHECKSTYLE.SUPPRESS\: (\w+) for ([+-]\d+) lines"/>
    <property name="checkPattern" value="$1"/>
    <property name="lineRange" value="$2"/>
  </module>
  <!-- Checks for whitespace                               -->
  <!-- See http://checkstyle.org/checks/whitespace/index.html -->
  <module name="FileTabCharacter">
    <property name="eachLine" value="true"/>
  </module>
  <module name="TreeWalker">
    <module name="OuterTypeFilename"/>
    <module name="IllegalTokenText">
      <property name="tokens" value="STRING_LITERAL, CHAR_LITERAL"/>
      <property name="format"
               value="\\u00(09|0(a|A)|0(c|C)|0(d|D)|22|27|5(C|c))|\\(0(10|11|12|14|15|42|47)|134)"/>
      <property name="message"
               value="Consider using special escape sequence instead of octal value or Unicode escaped value."/>
    </module>
    <module name="AvoidEscapedUnicodeCharacters">
      <property name="allowEscapesForControlCharacters" value="true"/>
      <property name="allowByTailComment" value="true"/>
      <property name="allowNonPrintableEscapes" value="true"/>
    </module>
    <module name="AvoidStarImport"/>
    <module name="OneTopLevelClass"/>
    <module name="NeedBraces">
      <property name="tokens"
               value="LITERAL_DO, LITERAL_ELSE, LITERAL_FOR, LITERAL_IF, LITERAL_WHILE"/>
    </module>
    <module name="OneStatementPerLine"/>
    <module name="MultipleVariableDeclarations"/>
    <module name="ArrayTypeStyle"/>
    <module name="MissingSwitchDefault"/>
    <module name="FallThrough"/>
    <module name="UpperEll"/>
    <module name="ModifierOrder"/>
    <module name="PackageName">
      <property name="format" value="^[a-z]+(\.[a-z][a-z0-9]*)*$"/>
      <message key="name.invalidPattern"
             value="Package name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="TypeName">
      <property name="tokens" value="CLASS_DEF, INTERFACE_DEF, ENUM_DEF,
                    ANNOTATION_DEF, RECORD_DEF"/>
      <message key="name.invalidPattern"
             value="Type name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="MemberName">
      <property name="format" value="^[a-z][a-z0-9][a-zA-Z0-9]*$"/>
      <message key="name.invalidPattern"
             value="Member name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="ParameterName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
             value="Parameter name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="LambdaParameterName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
             value="Lambda parameter name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="CatchParameterName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
             value="Catch parameter name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="LocalVariableName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
             value="Local variable name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="PatternVariableName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
             value="Pattern variable name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="ClassTypeParameterName">
      <property name="format" value="(^[A-Z][0-9]?)$|([A-Z][a-zA-Z0-9]*[T]$)"/>
      <message key="name.invalidPattern"
             value="Class type name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="RecordComponentName">
      <property name="format" value="^[a-z]([a-z0-9][a-zA-Z0-9]*)?$"/>
      <message key="name.invalidPattern"
               value="Record component name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="RecordTypeParameterName">
      <property name="format" value="(^[A-Z][0-9]?)$|([A-Z][a-zA-Z0-9]*[T]$)"/>
      <message key="name.invalidPattern"
               value="Record type name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="MethodTypeParameterName">
      <property name="format" value="(^[A-Z][0-9]?)$|([A-Z][a-zA-Z0-9]*[T]$)"/>
      <message key="name.invalidPattern"
             value="Method type name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="InterfaceTypeParameterName">
      <property name="format" value="(^[A-Z][0-9]?)$|([A-Z][a-zA-Z0-9]*[T]$)"/>
      <message key="name.invalidPattern"
             value="Interface type name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="NoFinalizer"/>
    <!-- Suppression for block code until we find a way to detect them properly
         until https://github.com/checkstyle/checkstyle/issues/15769 -->
    <module name="AbbreviationAsWordInName">
      <property name="ignoreFinal" value="false"/>
      <property name="allowedAbbreviationLength" value="0"/>
      <property name="tokens"
               value="CLASS_DEF, INTERFACE_DEF, ENUM_DEF, ANNOTATION_DEF, ANNOTATION_FIELD_DEF,
                    PARAMETER_DEF, VARIABLE_DEF, METHOD_DEF, PATTERN_VARIABLE_DEF, RECORD_DEF,
                    RECORD_COMPONENT_DEF"/>
    </module>
    <module name="OverloadMethodsDeclarationOrder"/>
    <module name="ConstructorsDeclarationGrouping"/>
    <module name="VariableDeclarationUsageDistance"/>
    <module name="NonEmptyAtclauseDescription"/>
    <module name="InvalidJavadocPosition"/>
    <module name="JavadocTagContinuationIndentation"/>
    <module name="SummaryJavadoc">
      <property name="forbiddenSummaryFragments"
               value="^@return the *|^This method returns |^A [{]@code [a-zA-Z0-9]+[}]( is a )"/>
    </module>
    <module name="JavadocParagraph">
      <property name="allowNewlineParagraph" value="false"/>
    </module>
    <module name="RequireEmptyLineBeforeBlockTagGroup"/>
    <module name="AtclauseOrder">
      <property name="tagOrder" value="@param, @return, @throws, @deprecated"/>
      <property name="target"
               value="CLASS_DEF, INTERFACE_DEF, ENUM_DEF, METHOD_DEF, CTOR_DEF, VARIABLE_DEF"/>
    </module>
    <module name="JavadocMethod">
      <property name="accessModifiers" value="public"/>
      <property name="allowMissingParamTags" value="true"/>
      <property name="allowMissingReturnTag" value="true"/>
      <property name="allowedAnnotations" value="Override, Test"/>
      <property name="tokens" value="METHOD_DEF, CTOR_DEF, ANNOTATION_FIELD_DEF, COMPACT_CTOR_DEF"/>
    </module>
    <module name="MissingJavadocMethod">
      <property name="scope" value="protected"/>
      <property name="allowMissingPropertyJavadoc" value="true"/>
      <property name="allowedAnnotations" value="Override, Test"/>
      <property name="tokens" value="METHOD_DEF, CTOR_DEF, ANNOTATION_FIELD_DEF,
                                   COMPACT_CTOR_DEF"/>
    </module>
    <module name="SuppressionXpathSingleFilter">
      <property name="checks" value="MissingJavadocMethod"/>
      <property name="query" value="//*[self::METHOD_DEF or self::CTOR_DEF
                                 or self::ANNOTATION_FIELD_DEF or self::COMPACT_CTOR_DEF]
                                 [ancestor::*[self::INTERFACE_DEF or self::CLASS_DEF
                                 or self::RECORD_DEF or self::ENUM_DEF]
                                 [not(./MODIFIERS/LITERAL_PUBLIC)]]"/>
    </module>
    <module name="MissingJavadocType">
      <property name="scope" value="protected"/>
      <property name="tokens"
                value="CLASS_DEF, INTERFACE_DEF, ENUM_DEF,
                      RECORD_DEF, ANNOTATION_DEF"/>
      <property name="excludeScope" value="nothing"/>
    </module>
    <module name="MethodName">
      <property name="format" value="^[a-z][a-z0-9][a-zA-Z0-9]*$"/>
      <message key="name.invalidPattern"
             value="Method name ''{0}'' must match pattern ''{1}''."/>
    </module>
    <module name="SuppressionXpathSingleFilter">
      <property name="checks" value="MethodName"/>
      <property name="query" value="//METHOD_DEF[
                                     ./MODIFIERS/ANNOTATION//IDENT[contains(@text, 'Test')]
                                   ]/IDENT"/>
      <property name="message" value="'[a-z][a-z0-9][a-zA-Z0-9]*(?:_[a-z][a-z0-9][a-zA-Z0-9]*)*'"/>
    </module>
    <module name="SingleLineJavadoc"/>
    <module name="EmptyCatchBlock">
      <property name="exceptionVariableName" value="expected"/>
    </module>
    <!-- https://checkstyle.org/filters/suppressionxpathfilter.html -->
    <module name="SuppressionXpathFilter">
      <property name="file" value="%{org.checkstyle.google.suppressionxpathfilter.config}"
             default="checkstyle-xpath-suppressions.xml" />
      <property name="optional" value="true"/>
    </module>
    <module name="SuppressWarningsHolder" />
    <module name="SuppressionCommentFilter">
      <property name="offCommentFormat" value="CHECKSTYLE.OFF\: ([\w\|]+)" />
      <property name="onCommentFormat" value="CHECKSTYLE.ON\: ([\w\|]+)" />
      <property name="checkFormat" value="$1" />
    </module>
    <module name="SuppressWithNearbyCommentFilter">
      <property name="commentFormat" value="CHECKSTYLE.SUPPRESS\: ([\w\|]+)"/>
      <!-- $1 refers to the first match group in the regex defined in commentFormat -->
      <property name="checkFormat" value="$1"/>
      <!-- The check is suppressed in the next line of code after the comment -->
      <property name="influenceFormat" value="1"/>
    </module>
    __DEVGUARD__
  </module>
`;

/** The Checker body of the trimmed google_checks.xml, with a line holding only the mark where devguard's modules go. */
export const GOOGLE_CHECKS_BODY: string = BODY.slice(1).replaceAll("%{", "${");
